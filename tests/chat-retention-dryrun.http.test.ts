// M4-T7 聊天保留候选查询与默认拒绝真实清理：纯策略/配置/门禁/cron 验收 + 隔离 PostgreSQL 真路由/作业状态验收。
//
// 纯用例（配置、策略门禁、cron 模板、只读表守卫与无库 handler 防线）在 `pnpm test` 下无条件运行；
// 真实数据库用例只认专属 loopback 变量 `M4T7_TEST_DATABASE_URL`（绝不回退 `DATABASE_URL`），
// `M4T7_REQUIRE_DATABASE=true` 时缺地址直接抛错，不静默 skip。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PrismaClient, type Role } from '@prisma/client';
import { authenticator } from 'otplib';
import { prodEnvProblems } from '../prod-env-check';
import { CHAT_RETENTION_MS } from '../src/lib/chat/rules';
import { JobResultDTOSchema, OperationsRequestSchema } from '../src/lib/contracts/ops';
import { encrypt, hashSecret } from '../src/lib/server/admin/crypto';
import {
  CHAT_RETENTION_POLICY,
  CHAT_RETENTION_POLICY_VERSION,
  CHAT_VISITOR_POLICY,
  ServerConfigError,
  chatRetentionPolicyProblems,
  parseChatRetentionPolicy,
} from '../src/lib/server/config';
import {
  CHAT_RETENTION_JOB_KEY,
  NON_AUTHORITATIVE_CHAT_RETENTION_SOURCES,
  assertChatRetentionDeleteAuthorized,
  chatContentExpiryCutoff,
  evaluateChatRetentionGate,
  isChatConversationExpired,
  visitorIdleExpiryCutoff,
} from '../src/lib/server/chat/retention-policy';
import type {
  createChatRetentionCandidateRepo as CreateChatRetentionCandidateRepoFn,
  runChatRetention as RunChatRetentionFn,
} from '../src/lib/server/chat/retention-candidates';
import type { createOperationsHandler as CreateOperationsHandlerFn } from '../src/lib/server/jobs/registry';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T05:17:00.000Z');
const SECRET = 'm4t7-cron-secret-for-isolated-tests-only';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function parseLoopbackUrl(raw: string | undefined): URL | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return null;
    if (!LOOPBACK.has(parsed.hostname.toLowerCase())) return null;
    return parsed;
  } catch {
    return null;
  }
}

const BASE_DB_URL = parseLoopbackUrl(process.env.M4T7_TEST_DATABASE_URL);
if (process.env.M4T7_REQUIRE_DATABASE === 'true' && !BASE_DB_URL) {
  throw new Error('M4T7_TEST_DATABASE_URL must be a loopback PostgreSQL URL when M4T7_REQUIRE_DATABASE=true');
}
const skipDb = !BASE_DB_URL && 'no loopback M4T7_TEST_DATABASE_URL';

function sha256Json(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)))
    .digest('hex');
}

/* ------------------------------------------------------------------ 纯逻辑、门禁与静态守卫 */

describe('M4-T7 策略配置、纯授权门禁与静态边界', () => {
  test('聊天保留策略默认 90 天、正整数 version、默认 dry-run 且真实清理关闭，与 7d/30d cookie 独立', () => {
    assert.equal(CHAT_RETENTION_POLICY.retainMs, 90 * DAY_MS);
    assert.equal(CHAT_RETENTION_POLICY.retainMs, CHAT_RETENTION_MS);
    assert.equal(CHAT_RETENTION_POLICY.policyVersion, CHAT_RETENTION_POLICY_VERSION);
    assert.equal(Number.isInteger(CHAT_RETENTION_POLICY.policyVersion) && CHAT_RETENTION_POLICY.policyVersion >= 1, true);
    assert.equal(CHAT_RETENTION_POLICY.defaultDryRun, true);
    assert.equal(CHAT_RETENTION_POLICY.cleanupEnabled, false);
    assert.ok(CHAT_RETENTION_POLICY.retainMs > CHAT_VISITOR_POLICY.absoluteMs);
    assert.equal(Object.isFrozen(CHAT_RETENTION_POLICY), true);
    assert.deepEqual(chatRetentionPolicyProblems(), []);
  });

  test('parseChatRetentionPolicy 与 prod-env-check 拒绝非法期限、默认开启删除且不泄露输入值', () => {
    const leak = 'LEAK-SECRET-INPUT-PROBE';
    assert.throws(
      () => parseChatRetentionPolicy({ retainMs: leak, policyVersion: 1, defaultDryRun: true, cleanupEnabled: false }),
      (error: unknown) => {
        assert.ok(error instanceof ServerConfigError);
        assert.match(error.message, /retainMs 无效/);
        assert.equal(error.message.includes(leak), false);
        return true;
      },
    );

    assert.throws(
      () => parseChatRetentionPolicy({
        retainMs: CHAT_VISITOR_POLICY.absoluteMs,
        policyVersion: 1,
        defaultDryRun: true,
        cleanupEnabled: false,
      }),
      /retainMs 无效/,
    );

    assert.throws(
      () => parseChatRetentionPolicy({
        retainMs: CHAT_RETENTION_MS,
        policyVersion: 0,
        defaultDryRun: true,
        cleanupEnabled: false,
      }),
      /policyVersion 无效/,
    );

    assert.throws(
      () => parseChatRetentionPolicy({
        retainMs: CHAT_RETENTION_MS,
        policyVersion: 1,
        defaultDryRun: false,
        cleanupEnabled: false,
      }),
      /defaultDryRun 无效/,
    );

    const enabledPolicy = parseChatRetentionPolicy({
      retainMs: CHAT_RETENTION_MS,
      policyVersion: 1,
      defaultDryRun: true,
      cleanupEnabled: true,
    });
    assert.deepEqual(
      chatRetentionPolicyProblems(enabledPolicy),
      ['chatRetention.cleanupEnabled 未获生产授权不得默认开启'],
    );
    // 保持既有生产基线报错数 22 不变。
    assert.equal(prodEnvProblems({ APP_ENV: 'production' }).length, 22);
  });

  test('E-88 纯授权门禁：默认 dry-run，缺授权/关开关/非授权来源（文档/模型/派发/代理/旧开关）一律拒绝', () => {
    const def = evaluateChatRetentionGate();
    assert.equal(def.mode, 'dry-run');
    assert.equal(def.dryRun, true);
    assert.equal(def.rejected, false);
    assert.equal(def.authorized, false);
    assert.equal(def.reason, 'dry_run_default');
    assert.equal(def.policyVersion, CHAT_RETENTION_POLICY.policyVersion);
    assert.throws(() => assertChatRetentionDeleteAuthorized(def));

    const explicitDry = evaluateChatRetentionGate({ dryRun: true, deleteAuthorized: true });
    assert.equal(explicitDry.mode, 'dry-run');
    assert.equal(explicitDry.rejected, false);

    // 仅请求 dryRun:false 但政策未启用：拒绝
    const disabled = evaluateChatRetentionGate({ dryRun: false, deleteAuthorized: true });
    assert.equal(disabled.mode, 'dry-run');
    assert.equal(disabled.rejected, true);
    assert.equal(disabled.authorized, false);
    assert.equal(disabled.reason, 'policy_cleanup_disabled');
    assert.throws(() => assertChatRetentionDeleteAuthorized(disabled));

    const enabledPolicy = parseChatRetentionPolicy({ ...CHAT_RETENTION_POLICY, cleanupEnabled: true });

    // 策略已开但缺少明确授权：拒绝
    const missingAuth = evaluateChatRetentionGate({ dryRun: false, policy: enabledPolicy });
    assert.equal(missingAuth.mode, 'dry-run');
    assert.equal(missingAuth.rejected, true);
    assert.equal(missingAuth.reason, 'authorization_missing');

    // 策略 version 不匹配：拒绝
    const badVersion = evaluateChatRetentionGate({
      dryRun: false,
      deleteAuthorized: true,
      policy: enabledPolicy,
      expectedPolicyVersion: CHAT_RETENTION_POLICY.policyVersion + 1,
    });
    assert.equal(badVersion.mode, 'dry-run');
    assert.equal(badVersion.rejected, true);
    assert.equal(badVersion.reason, 'policy_version_mismatch');

    // 文档、任务派发、模型、代理结论或旧 RETENTION_CLEANUP_MODE 均不能充当授权
    for (const source of NON_AUTHORITATIVE_CHAT_RETENTION_SOURCES) {
      const forged = evaluateChatRetentionGate({
        dryRun: false,
        deleteAuthorized: true,
        policy: enabledPolicy,
        authorizationSource: source,
      });
      assert.equal(forged.mode, 'dry-run', source);
      assert.equal(forged.rejected, true, source);
      assert.equal(forged.authorized, false, source);
      assert.equal(forged.reason, 'non_authoritative_source_rejected', source);
      assert.throws(() => assertChatRetentionDeleteAuthorized(forged));
    }
  });

  test('90 天 retainUntil 与 7d 闲置时间计算遵循等号即到期且忽略已匿名化行', () => {
    const expiry = new Date(NOW.getTime());
    assert.equal(isChatConversationExpired({ retainUntil: expiry, anonymizedAt: null }, NOW), true);
    assert.equal(isChatConversationExpired({ retainUntil: new Date(NOW.getTime() + 1), anonymizedAt: null }, NOW), false);
    assert.equal(isChatConversationExpired({ retainUntil: expiry, anonymizedAt: NOW }, NOW), false);
    assert.equal(chatContentExpiryCutoff(NOW).toISOString(), new Date(NOW.getTime() - 90 * DAY_MS).toISOString());
    assert.equal(visitorIdleExpiryCutoff(NOW).toISOString(), new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
    assert.throws(() => chatContentExpiryCutoff(new Date(Number.NaN)), /invalid_instant/);
  });

  test('OperationsRequestSchema 与 JobResultDTOSchema 支持 chat-retention 并拒绝非法 dryRun/额外字段', () => {
    assert.deepEqual(OperationsRequestSchema.parse({ jobKey: CHAT_RETENTION_JOB_KEY }), { jobKey: 'chat-retention', dryRun: true });
    assert.deepEqual(OperationsRequestSchema.parse({ jobKey: 'chat-retention', dryRun: false }), { jobKey: 'chat-retention', dryRun: false });
    assert.equal(OperationsRequestSchema.safeParse({ jobKey: 'chat-retention', dryRun: 'false' }).success, false);
    assert.equal(OperationsRequestSchema.safeParse({ jobKey: 'chat-retention', extra: 1 }).success, false);

    const dto = JobResultDTOSchema.parse({
      jobKey: 'chat-retention',
      status: 'FAILED',
      counts: { candidateCount: 3, deletedCount: 0 },
      finishedAt: NOW.toISOString(),
    });
    assert.equal(dto.counts.deletedCount, 0);
  });

  test('候选仓储、策略文件与 registry 满足只读/单向依赖/零敏感列边界', () => {
    const candidatesSrc = readFileSync(new URL('../src/lib/server/chat/retention-candidates.ts', import.meta.url), 'utf8');
    const policySrc = readFileSync(new URL('../src/lib/server/chat/retention-policy.ts', import.meta.url), 'utf8');
    const registrySrc = readFileSync(new URL('../src/lib/server/jobs/registry.ts', import.meta.url), 'utf8');

    // registry 不导入 M4/M6 实现（08 节架构规则）
    assert.doesNotMatch(registrySrc, /\.\.\/chat\//);

    // M4-T7 绝不含任何写删业务表 SQL/方法
    for (const src of [candidatesSrc, policySrc]) {
      assert.doesNotMatch(src, /DELETE\s+FROM|UPDATE\s+"|INSERT\s+INTO|deleteMany|updateMany/i);
      for (const forbiddenTable of [
        'Inquiry', 'InquiryItem', 'InquiryMessage', 'InquiryNote', 'Contact',
        'AnalyticsEvent', 'AnalyticsDaily', 'AnalyticsDailyRollup', 'AnalyticsRollupDay',
        'AnalyticsAggregateDayState', 'AnalyticsDayChange', 'OpsSourceSnapshot', 'MailMessage',
      ]) {
        assert.equal(src.includes(`"${forbiddenTable}"`), false, `不得查询无关表 ${forbiddenTable}`);
      }
      for (const sensitiveCol of ['"bodyText"', '"email"', '"sourcePath"', '"tokenHash"', '"payloadHash"', '"createPayloadHash"']) {
        assert.equal(src.includes(sensitiveCol), false, `候选仓储不得选择敏感列 ${sensitiveCol}`);
      }
    }
  });

  test('deploy/cron.nbshiyan 每日按 operations POST 触发 chat-retention、默认 dry-run 且无硬编码密钥', () => {
    const cron = readFileSync(new URL('../deploy/cron.nbshiyan', import.meta.url), 'utf8');
    const lines = cron.split(/\r?\n/);
    const chatRetLines = lines.filter(
      (line) => !line.trimStart().startsWith('#') && line.includes('/api/admin/cron/operations') && line.includes("jobKey:'chat-retention'"),
    );
    assert.equal(chatRetLines.length, 1, 'deploy/cron.nbshiyan 必须恰有一条 chat-retention 有效调度行');
    const line = chatRetLines[0]!;
    assert.match(line, /^\d{1,2} \d{1,2} \* \* \* /);
    assert.match(line, /method:'POST'/);
    assert.match(line, /process\.env\.CRON_SECRET/);
    assert.equal(line.replaceAll('process.env.CRON_SECRET', '').includes('CRON_SECRET'), false);
    assert.match(line, /AbortSignal\.timeout\(55000\)/);
    assert.match(line, /r\.status===409\?0:1/);
    assert.match(line, />> @DATA_DIR@\/cron-chat-retention\.log 2>&1$/);
    assert.doesNotMatch(line, /dryRun\s*:\s*false/);
    assert.doesNotMatch(line, /RETENTION_CLEANUP_MODE/);
  });

  test('组合点注册 chat-retention 且不受 RETENTION_CLEANUP_MODE=delete 影响；工厂构造期不读库', () => {
    const script = [
      '(async () => {',
      "  const assert = require('node:assert/strict');",
      "  const { createChatRetentionJob } = require('./src/lib/server/chat/retention-candidates');",
      "  const { createJobServices } = require('./src/lib/server/composition');",
      "  const { createOperationsHandler } = require('./src/lib/server/jobs/registry');",
      "  const neverDb = new Proxy({}, { get: () => { throw new Error('db touched during construction'); } });",
      "  const job = createChatRetentionJob({ db: neverDb });",
      "  assert.equal(job.key, 'chat-retention');",
      "  const services = createJobServices({ db: neverDb });",
      "  assert.equal(services.jobs.has('chat-retention'), true);",
      `  const handler = createOperationsHandler({ services: services.jobs, secret: ${JSON.stringify(SECRET)}, clock: () => new Date(${NOW.getTime()}) });`,
      "  assert.equal((await handler(new Request('http://127.0.0.1:3000/api/admin/cron/operations', { method: 'POST', body: '{}' }))).status, 401);",
      "  assert.equal((await handler(new Request('http://127.0.0.1:3000/api/admin/cron/operations', {",
      "    method: 'POST',",
      `    headers: { authorization: 'Bearer ${SECRET}', 'content-type': 'application/json' },`,
      "    body: JSON.stringify({ jobKey: 'chat-retention', dryRun: 'false' }),",
      "  }))).status, 400);",
      '})().catch((err) => { console.error(err); process.exit(1); });',
    ].join('\n');
    execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', RETENTION_CLEANUP_MODE: 'delete' },
      stdio: 'pipe',
    });
  });

  test('expiredConversationRefs 越界 limit 拒绝（不执行查询）', () => {
    const script = [
      '(async () => {',
      "  const assert = require('node:assert/strict');",
      "  const { CHAT_RETENTION_MAX_CANDIDATE_SCAN, createChatRetentionCandidateRepo } = require('./src/lib/server/chat/retention-candidates');",
      "  let called = false;",
      "  const fakeDb = { $queryRaw: async () => { called = true; return []; } };",
      `  const repo = createChatRetentionCandidateRepo({ db: fakeDb, now: new Date(${NOW.getTime()}) });`,
      "  await assert.rejects(() => repo.expiredConversationRefs(0), /invalid_limit/);",
      "  await assert.rejects(() => repo.expiredConversationRefs(CHAT_RETENTION_MAX_CANDIDATE_SCAN + 1), /invalid_limit/);",
      "  assert.equal(called, false);",
      '})().catch((err) => { console.error(err); process.exit(1); });',
    ].join('\n');
    execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test' },
      stdio: 'pipe',
    });
  });
});

/* ------------------------------------------------------------------ 隔离 PostgreSQL 真实 HTTP 与作业验证 */

describe('M4-T7 隔离 PostgreSQL 真实接线、保留期限与拒绝删除验收', { concurrency: false, skip: skipDb, timeout: 180_000 }, () => {
  const schema = `m4t7_${randomBytes(6).toString('hex')}`;
  let owner: PrismaClient;
  let db: PrismaClient;
  let appDb: PrismaClient | undefined;
  let ownedSchema = false;

  let createChatRetentionCandidateRepo: typeof CreateChatRetentionCandidateRepoFn;
  let runChatRetention: typeof RunChatRetentionFn;
  let createOperationsHandler: typeof CreateOperationsHandlerFn;
  let CHAT_VISITOR_COOKIE: string;
  let hashChatToken: (token: string) => string;

  let auth: typeof import('../src/app/api/auth/[...nextauth]/route');
  let operationsPostRoute: typeof import('../src/app/api/admin/cron/operations/route').POST;
  let chatSessionRoute: typeof import('../src/app/api/chat/session/route').POST;
  let chatCreateRoute: typeof import('../src/app/api/chat/conversations/route').POST;
  let visitorSyncRoute: typeof import('../src/app/api/chat/conversations/[id]/route').GET;
  let visitorAppendRoute: typeof import('../src/app/api/chat/conversations/[id]/messages/route').POST;
  let visitorReadRoute: typeof import('../src/app/api/chat/conversations/[id]/read/route').POST;
  let adminInboxRoute: typeof import('../src/app/api/admin/chat/conversations/route').GET;
  let adminDetailRoute: typeof import('../src/app/api/admin/chat/conversations/[id]/route').GET;
  let adminReplyRoute: typeof import('../src/app/api/admin/chat/conversations/[id]/messages/route').POST;
  let adminReadRoute: typeof import('../src/app/api/admin/chat/conversations/[id]/read/route').POST;

  const origin = 'http://127.0.0.1:3000';

  async function createOwnedSchema(client: PrismaClient, name: string): Promise<boolean> {
    const existing = await client.$queryRaw<{ one: number }[]>`
      SELECT 1 AS "one" FROM pg_namespace WHERE nspname = ${name}
    `;
    if (existing.length > 0) return false;
    await client.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
    return true;
  }

  async function resetTables() {
    await db.$executeRawUnsafe(`
      TRUNCATE TABLE
        "ChatNotification",
        "ChatReadCursor",
        "ChatMessage",
        "ChatConversation",
        "ChatVisitorSession",
        "JobState",
        "SiteSetting",
        "AuditLog",
        "AnalyticsEvent",
        "AnalyticsDaily",
        "AnalyticsDailyRollup",
        "Inquiry",
        "Contact",
        "AdminDeviceSession",
        "User"
      CASCADE
    `);
  }

  async function tableContentHashes(): Promise<Record<string, string>> {
    const [sessions, conversations, messages, cursors, notifications, inquiries, contacts, events, daily, rollups, audits, settings] = await Promise.all([
      db.chatVisitorSession.findMany({ orderBy: { id: 'asc' } }),
      db.chatConversation.findMany({ orderBy: { id: 'asc' } }),
      db.chatMessage.findMany({ orderBy: { id: 'asc' } }),
      db.chatReadCursor.findMany({ orderBy: [{ conversationId: 'asc' }, { userId: 'asc' }] }),
      db.chatNotification.findMany({ orderBy: { id: 'asc' } }),
      db.inquiry.findMany({ orderBy: { id: 'asc' } }),
      db.contact.findMany({ orderBy: { id: 'asc' } }),
      db.analyticsEvent.findMany({ orderBy: { eventId: 'asc' } }),
      db.analyticsDaily.findMany({ orderBy: [{ localDate: 'asc' }, { timezoneRevision: 'asc' }, { dimension: 'asc' }] }),
      db.analyticsDailyRollup.findMany({ orderBy: [{ siteDate: 'asc' }, { kind: 'asc' }, { locale: 'asc' }, { productSlug: 'asc' }] }),
      db.auditLog.findMany({ orderBy: { id: 'asc' } }),
      // `analytics.settings` 由 M5-T1 lease-repo 串行化初始化，除该租约元键外的站点设置必须保持零改动
      db.siteSetting.findMany({ where: { key: { not: 'analytics.settings' } }, orderBy: { key: 'asc' } }),
    ]);
    return {
      ChatVisitorSession: sha256Json(sessions),
      ChatConversation: sha256Json(conversations),
      ChatMessage: sha256Json(messages),
      ChatReadCursor: sha256Json(cursors),
      ChatNotification: sha256Json(notifications),
      Inquiry: sha256Json(inquiries),
      Contact: sha256Json(contacts),
      AnalyticsEvent: sha256Json(events),
      AnalyticsDaily: sha256Json(daily),
      AnalyticsDailyRollup: sha256Json(rollups),
      AuditLog: sha256Json(audits),
      SiteSetting: sha256Json(settings),
    };
  }

  async function loginOperator(role: Role): Promise<{ userId: string; cookie: string }> {
    const password = 'm4t7-operator-test-password';
    const totpSecret = authenticator.generateSecret();
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: `M4T7 ${role}`,
        role,
        passwordHash: await hashSecret(password),
        totpEnabled: true,
        totpSecret: encrypt(totpSecret),
      },
    });
    const csrfRes = await auth.GET(new Request(`${origin}/api/auth/csrf`));
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const csrfCookie = csrfRes.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
    const loginRes = await auth.POST(new Request(`${origin}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: {
        cookie: csrfCookie,
        origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        email: user.email,
        password,
        csrfToken,
        totp: authenticator.generate(totpSecret),
      }),
    }));
    assert.equal(loginRes.status, 302);
    const sessionCookies = loginRes.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
    return { userId: user.id, cookie: sessionCookies };
  }

  function extractVisitorCookie(response: Response): string {
    const hit = response.headers.getSetCookie().find((c) => c.startsWith(`${CHAT_VISITOR_COOKIE}=`));
    assert.ok(hit, '必须签发 pj_chat cookie');
    return hit.split(';', 1)[0]!;
  }

  before(async () => {
    assert.ok(BASE_DB_URL);
    const adminUrl = new URL(BASE_DB_URL);
    adminUrl.searchParams.delete('schema');
    owner = new PrismaClient({ datasourceUrl: adminUrl.href });
    ownedSchema = await createOwnedSchema(owner, schema);
    assert.equal(ownedSchema, true, '测试 schema 不得与已存在对象冲突');

    const isolatedUrl = new URL(BASE_DB_URL);
    isolatedUrl.searchParams.set('schema', schema);
    isolatedUrl.searchParams.set('connection_limit', '5');
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: isolatedUrl.href },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = isolatedUrl.href;
    process.env.APP_ENV = 'test';
    process.env.AUTH_SECRET = 'm4t7-auth-secret-for-isolated-tests';
    process.env.PRIVACY_HASH_SECRET = 'm4t7-privacy-hash-secret-for-tests-32b';
    process.env.ADMIN_TOTP_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.EDGE_AUTH_SECRET = 'm4t7-edge-auth-secret-for-tests-32b';
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;

    db = new PrismaClient({ datasourceUrl: isolatedUrl.href });
    ({ prisma: appDb } = await import('../src/lib/server/db'));
    await appDb.$connect();
    ({ createChatRetentionCandidateRepo, runChatRetention } = await import('../src/lib/server/chat/retention-candidates'));
    ({ createOperationsHandler } = await import('../src/lib/server/jobs/registry'));
    ({ CHAT_VISITOR_COOKIE, hashChatToken } = await import('../src/lib/server/chat/visitor-session'));
    setRateLimitStore(new MemoryStore());

    auth = await import('../src/app/api/auth/[...nextauth]/route');
    ({ POST: operationsPostRoute } = await import('../src/app/api/admin/cron/operations/route'));
    ({ POST: chatSessionRoute } = await import('../src/app/api/chat/session/route'));
    ({ POST: chatCreateRoute } = await import('../src/app/api/chat/conversations/route'));
    ({ GET: visitorSyncRoute } = await import('../src/app/api/chat/conversations/[id]/route'));
    ({ POST: visitorAppendRoute } = await import('../src/app/api/chat/conversations/[id]/messages/route'));
    ({ POST: visitorReadRoute } = await import('../src/app/api/chat/conversations/[id]/read/route'));
    ({ GET: adminInboxRoute } = await import('../src/app/api/admin/chat/conversations/route'));
    ({ GET: adminDetailRoute } = await import('../src/app/api/admin/chat/conversations/[id]/route'));
    ({ POST: adminReplyRoute } = await import('../src/app/api/admin/chat/conversations/[id]/messages/route'));
    ({ POST: adminReadRoute } = await import('../src/app/api/admin/chat/conversations/[id]/read/route'));
  });

  beforeEach(async () => {
    setRateLimitStore(new MemoryStore());
    await resetTables();
  });

  after(async () => {
    setRateLimitStore(undefined);
    await appDb?.$disconnect();
    await db?.$disconnect();
    try {
      if (ownedSchema) await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await owner?.$disconnect();
    }
  });

  async function seedSessionWithConversation(opts: {
    sessionId?: string;
    token?: string;
    sessionCreatedAt?: Date;
    sessionLastActivityAt?: Date;
    sessionAbsoluteExpiresAt?: Date;
    sessionRevokedAt?: Date | null;
    conversationId?: string;
    retainUntil: Date;
    lastActivityAt?: Date;
    anonymizedAt?: Date | null;
    email?: string | null;
    bodyText?: string;
  }) {
    const sessionId = opts.sessionId ?? randomUUID();
    const token = opts.token ?? randomBytes(32).toString('base64url');
    const createdAt = opts.sessionCreatedAt ?? new Date(NOW.getTime() - 10 * DAY_MS);
    await db.chatVisitorSession.create({
      data: {
        id: sessionId,
        tokenHash: hashChatToken(token),
        createdAt,
        lastActivityAt: opts.sessionLastActivityAt ?? createdAt,
        absoluteExpiresAt: opts.sessionAbsoluteExpiresAt ?? new Date(createdAt.getTime() + CHAT_VISITOR_POLICY.absoluteMs),
        revokedAt: opts.sessionRevokedAt ?? null,
      },
    });
    const conversationId = opts.conversationId ?? randomUUID();
    const lastActivityAt = opts.lastActivityAt ?? new Date(opts.retainUntil.getTime() - CHAT_RETENTION_MS);
    const bodyText = opts.bodyText ?? 'Sensitive chat body text';
    await db.chatConversation.create({
      data: {
        id: conversationId,
        visitorSessionId: sessionId,
        clientConversationId: randomUUID(),
        createPayloadHash: sha256Json({ id: conversationId }),
        locale: 'en',
        productSlug: null,
        sourcePath: '/en/contact',
        email: opts.email ?? 'sensitive.visitor@example.test',
        status: 'OPEN',
        version: 0,
        lastSeq: 1,
        visitorReadSeq: 0,
        createdAt: lastActivityAt,
        updatedAt: lastActivityAt,
        lastActivityAt,
        retainUntil: opts.retainUntil,
        anonymizedAt: opts.anonymizedAt ?? null,
      },
    });
    const messageId = randomUUID();
    await db.chatMessage.create({
      data: {
        id: messageId,
        conversationId,
        seq: 1,
        sender: 'VISITOR',
        authorId: null,
        clientMessageId: randomUUID(),
        payloadHash: sha256Json({ bodyText }),
        bodyText,
        createdAt: lastActivityAt,
      },
    });
    await db.chatNotification.create({
      data: {
        id: randomUUID(),
        conversationId,
        messageId,
        status: 'QUEUED',
        attempts: 0,
        availableAt: lastActivityAt,
        stableMessageId: `${messageId}@chat.packjoyu`,
        createdAt: lastActivityAt,
        updatedAt: lastActivityAt,
      },
    });
    return { sessionId, token, conversationId, messageId };
  }

  test('1) E-88 真实 route.POST + 默认生产组合点：缺 Bearer 401、默认 dry-run、未授权 dryRun:false 拒绝且哈希不变', async () => {
    const wallNow = new Date();
    const secretBody = 'TOP-SECRET-CUSTOMER-CONTENT-991';
    const secretEmail = 'confidential-buyer@example.test';
    await seedSessionWithConversation({ retainUntil: new Date(wallNow.getTime() - 60_000), bodyText: secretBody, email: secretEmail });
    await seedSessionWithConversation({ retainUntil: new Date(wallNow.getTime() - 5_000), bodyText: `${secretBody}-2`, email: `2-${secretEmail}` });
    await seedSessionWithConversation({ retainUntil: new Date(wallNow.getTime() + 10 * DAY_MS), bodyText: `${secretBody}-active`, email: `active-${secretEmail}` });

    const beforeHashes = await tableContentHashes();

    const prevCronSecret = process.env.CRON_SECRET;
    const prevMode = process.env.RETENTION_CLEANUP_MODE;
    process.env.CRON_SECRET = SECRET;
    process.env.RETENTION_CLEANUP_MODE = 'delete';

    const logs: string[] = [];
    const origInfo = console.info;
    const origWarn = console.warn;
    console.info = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    console.warn = (...args: unknown[]) => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };

    try {
      // 缺 Bearer / 错 Bearer 经真实 operations route.POST 拒绝 401，不触发默认组合点也不写库
      const noBearerRes = await operationsPostRoute(new Request(`${origin}/api/admin/cron/operations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobKey: 'chat-retention' }),
      }));
      assert.equal(noBearerRes.status, 401);
      assert.equal(noBearerRes.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(await noBearerRes.json(), { error: 'unauthorized' });

      const wrongBearerRes = await operationsPostRoute(new Request(`${origin}/api/admin/cron/operations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}-wrong`, 'content-type': 'application/json' },
        body: JSON.stringify({ jobKey: 'chat-retention' }),
      }));
      assert.equal(wrongBearerRes.status, 401);
      assert.equal(await db.jobState.findUnique({ where: { key: 'chat-retention' } }), null);
      assert.deepEqual(await tableContentHashes(), beforeHashes);

      const postViaRealRoute = (body: unknown) =>
        operationsPostRoute(new Request(`${origin}/api/admin/cron/operations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));

      // 默认 dryRun 经真实 POST 与默认生产组合点：SUCCEEDED、candidateCount=2、deletedCount=0
      const dryRes = await postViaRealRoute({ jobKey: 'chat-retention' });
      assert.equal(dryRes.status, 200);
      const dryBody = JobResultDTOSchema.parse(await dryRes.json());
      assert.equal(dryBody.jobKey, 'chat-retention');
      assert.equal(dryBody.status, 'SUCCEEDED');
      assert.deepEqual(dryBody.counts, { candidateCount: 2, deletedCount: 0 });

      const afterDryState = await db.jobState.findUniqueOrThrow({ where: { key: 'chat-retention' } });
      assert.equal(afterDryState.lastStatus, 'SUCCEEDED');
      assert.equal(afterDryState.lastErrorCode, null);
      assert.ok(afterDryState.lastSucceededAt !== null);
      assert.deepEqual((afterDryState.summary as { counts?: unknown }).counts, { candidateCount: 2, deletedCount: 0 });
      assert.equal((afterDryState.summary as { versions?: { policyVersion?: number } }).versions?.policyVersion, CHAT_RETENTION_POLICY_VERSION);
      const drySucceededAt = afterDryState.lastSucceededAt!.toISOString();
      const afterFirstRunSiteSettings = await db.siteSetting.findMany({ orderBy: { key: 'asc' } });

      // 即使容器设了 RETENTION_CLEANUP_MODE=delete，显式 dryRun:false 经真实 POST 仍拒绝（FAILED/forbidden）且 deletedCount=0
      const deleteRes = await postViaRealRoute({ jobKey: 'chat-retention', dryRun: false });
      assert.equal(deleteRes.status, 200);
      const deleteBody = JobResultDTOSchema.parse(await deleteRes.json());
      assert.equal(deleteBody.jobKey, 'chat-retention');
      assert.equal(deleteBody.status, 'FAILED');
      assert.deepEqual(deleteBody.counts, { candidateCount: 2, deletedCount: 0 });

      const afterRejectState = await db.jobState.findUniqueOrThrow({ where: { key: 'chat-retention' } });
      assert.equal(afterRejectState.lastStatus, 'FAILED');
      assert.equal(afterRejectState.lastErrorCode, 'forbidden');
      assert.equal(afterRejectState.lastSucceededAt?.toISOString(), drySucceededAt, '拒绝轮不得覆盖上一次成功时间');
      assert.deepEqual((afterRejectState.summary as { counts?: unknown }).counts, { candidateCount: 2, deletedCount: 0 });

      // 隔离库前后所有业务行内容哈希完全一致（且首次运行后含 analytics.settings 在内的 SiteSetting 也不再变化）
      assert.deepEqual(await tableContentHashes(), beforeHashes);
      assert.deepEqual(await db.siteSetting.findMany({ orderBy: { key: 'asc' } }), afterFirstRunSiteSettings);

      // 日志、HTTP 响应与 JobState 摘要均不含正文或 email
      const combinedArtifacts = JSON.stringify({ dryBody, deleteBody, summary: afterRejectState.summary, logs });
      assert.equal(combinedArtifacts.includes(secretBody), false, '正文不得泄露进返回或日志');
      assert.equal(combinedArtifacts.includes(secretEmail), false, 'email 不得泄露进返回或日志');
    } finally {
      console.info = origInfo;
      console.warn = origWarn;
      if (prevCronSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevCronSecret;
      if (prevMode === undefined) delete process.env.RETENTION_CLEANUP_MODE;
      else process.env.RETENTION_CLEANUP_MODE = prevMode;
    }
  });

  test('2) E-85：90d retainUntil 等号到期，7d 闲置 / 30d 绝对 / 撤销 cookie 失效不提前选中保留期内咨询', async () => {
    const wallNow = new Date();
    // 1. 7 天闲置到期 cookie（在真路由会 401），但其咨询还有 60 天才满 90 天 -> 不得被选中
    const idleCookie = await seedSessionWithConversation({
      sessionCreatedAt: new Date(wallNow.getTime() - 10 * DAY_MS),
      sessionLastActivityAt: new Date(wallNow.getTime() - 7 * DAY_MS),
      retainUntil: new Date(wallNow.getTime() + 60 * DAY_MS),
    });
    // 验证真路由确实按 7d 闲置拒绝了该 cookie
    const rejectedAppend = await visitorAppendRoute(
      new Request(`${origin}/api/chat/conversations/${idleCookie.conversationId}/messages`, {
        method: 'POST',
        headers: {
          origin,
          cookie: `${CHAT_VISITOR_COOKIE}=${idleCookie.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ clientMessageId: randomUUID(), bodyText: 'should fail 401' }),
      }),
      { params: Promise.resolve({ id: idleCookie.conversationId }) },
    );
    assert.equal(rejectedAppend.status, 401);

    // 2. 30 天绝对到期 cookie，但其咨询还在 90 天保留期内 -> 不得选中
    await seedSessionWithConversation({
      sessionCreatedAt: new Date(wallNow.getTime() - 31 * DAY_MS),
      sessionLastActivityAt: new Date(wallNow.getTime() - DAY_MS),
      sessionAbsoluteExpiresAt: new Date(wallNow.getTime() - 1_000),
      retainUntil: new Date(wallNow.getTime() + 5 * DAY_MS),
    });

    // 3. 已撤销 cookie，但其咨询还在 90 天保留期内 -> 不得选中
    await seedSessionWithConversation({
      sessionRevokedAt: new Date(wallNow.getTime() - 1_000),
      retainUntil: new Date(wallNow.getTime() + 10 * DAY_MS),
    });

    // 4. 空且过期的 session（无咨询） -> 不计入 candidateCount
    await db.chatVisitorSession.create({
      data: {
        id: randomUUID(),
        tokenHash: hashChatToken(randomBytes(32).toString('base64url')),
        createdAt: new Date(wallNow.getTime() - 20 * DAY_MS),
        lastActivityAt: new Date(wallNow.getTime() - 8 * DAY_MS),
        absoluteExpiresAt: new Date(wallNow.getTime() + 10 * DAY_MS),
      },
    });

    // 5. 已匿名化但 retainUntil 已过的历史记录 -> 不得重复选中
    await seedSessionWithConversation({
      retainUntil: new Date(wallNow.getTime() - DAY_MS),
      anonymizedAt: new Date(wallNow.getTime() - 1_000),
    });

    // 6. 唯一满足 90d retainUntil <= now 且未匿名化的记录 -> 恰选中 1 条
    const due = await seedSessionWithConversation({
      retainUntil: wallNow,
    });

    const summary = await createChatRetentionCandidateRepo({ db, now: wallNow }).summary();
    assert.equal(summary.candidateCount, 1);
    assert.equal(summary.emptyExpiredSessionCount, 1);
    assert.equal(summary.oldestRetainUntil, wallNow.toISOString());
    assert.equal(summary.newestRetainUntil, wallNow.toISOString());

    const refs = await createChatRetentionCandidateRepo({ db, now: wallNow }).expiredConversationRefs(10);
    assert.deepEqual(refs.map((r) => r.id), [due.conversationId]);
  });

  test('3) E-86：轮询/访客已读/运营读取/通知状态更新均不延长 90d；成功保存访客消息或人工回复才推进 retainUntil', async () => {
    const admin = await loginOperator('ADMIN');
    const sessionRes = await chatSessionRoute(new Request(`${origin}/api/chat/session`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    }));
    assert.equal(sessionRes.status, 200);
    const visitorCookie = extractVisitorCookie(sessionRes);

    const createRes = await chatCreateRoute(new Request(`${origin}/api/chat/conversations`, {
      method: 'POST',
      headers: { origin, cookie: visitorCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientConversationId: randomUUID(),
        clientMessageId: randomUUID(),
        locale: 'en',
        bodyText: 'Initial inquiry message',
        email: 'buyer@example.test',
      }),
    }));
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as { conversationId: string; message: { id: string } };
    const convBefore = await db.chatConversation.findUniqueOrThrow({ where: { id: created.conversationId } });
    const initialRetainMs = convBefore.retainUntil.getTime();

    // 1. 访客轮询 GET
    const pollRes = await visitorSyncRoute(
      new Request(`${origin}/api/chat/conversations/${created.conversationId}?afterSeq=0`, {
        headers: { cookie: visitorCookie },
      }),
      { params: Promise.resolve({ id: created.conversationId }) },
    );
    assert.equal(pollRes.status, 200);

    // 2. 访客已读 POST
    const vReadRes = await visitorReadRoute(
      new Request(`${origin}/api/chat/conversations/${created.conversationId}/read`, {
        method: 'POST',
        headers: { origin, cookie: visitorCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ lastReadSeq: 1 }),
      }),
      { params: Promise.resolve({ id: created.conversationId }) },
    );
    assert.equal(vReadRes.status, 200);

    // 3. 运营收件箱 GET / 详情 GET / 运营已读 POST
    assert.equal((await adminInboxRoute(new Request(`${origin}/api/admin/chat/conversations`, { headers: { cookie: admin.cookie } }))).status, 200);
    assert.equal((await adminDetailRoute(
      new Request(`${origin}/api/admin/chat/conversations/${created.conversationId}`, { headers: { cookie: admin.cookie } }),
      { params: Promise.resolve({ id: created.conversationId }) },
    )).status, 200);
    assert.equal((await adminReadRoute(
      new Request(`${origin}/api/admin/chat/conversations/${created.conversationId}/read`, {
        method: 'POST',
        headers: { origin, cookie: admin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ lastReadSeq: 1 }),
      }),
      { params: Promise.resolve({ id: created.conversationId }) },
    )).status, 200);

    // 4. 通知重试与回执写入 ChatNotification
    await db.chatNotification.update({
      where: { messageId: created.message.id },
      data: { status: 'SENT', attempts: 2, sentAt: new Date() },
    });

    const convAfterNonMessage = await db.chatConversation.findUniqueOrThrow({ where: { id: created.conversationId } });
    assert.equal(convAfterNonMessage.retainUntil.getTime(), initialRetainMs, '轮询、read 与通知均不得推迟 90d retainUntil');

    // 在原到期时间点即被候选查询命中
    const dueSummary = await createChatRetentionCandidateRepo({ db, now: convBefore.retainUntil }).summary();
    assert.equal(dueSummary.candidateCount, 1);

    // 模拟已接近 90d 末期（剩 1 天到期），随后访客成功发送新消息 -> retainUntil 推进到新消息 + 90d
    const nearExpiry = new Date(Date.now() + DAY_MS);
    await db.chatConversation.update({
      where: { id: created.conversationId },
      data: { retainUntil: nearExpiry, lastActivityAt: new Date(nearExpiry.getTime() - CHAT_RETENTION_MS) },
    });
    const appendRes = await visitorAppendRoute(
      new Request(`${origin}/api/chat/conversations/${created.conversationId}/messages`, {
        method: 'POST',
        headers: { origin, cookie: visitorCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ clientMessageId: randomUUID(), bodyText: 'Follow-up from visitor' }),
      }),
      { params: Promise.resolve({ id: created.conversationId }) },
    );
    assert.equal(appendRes.status, 200);
    const afterVisitorMsg = await db.chatConversation.findUniqueOrThrow({ where: { id: created.conversationId } });
    assert.ok(afterVisitorMsg.retainUntil.getTime() > nearExpiry.getTime() + 80 * DAY_MS);
    assert.equal((await createChatRetentionCandidateRepo({ db, now: nearExpiry }).summary()).candidateCount, 0);

    // 再次将 retainUntil 移近到期，随后运营人工回复 -> retainUntil 再次推进 90d
    const nearExpiry2 = new Date(Date.now() + 2 * DAY_MS);
    await db.chatConversation.update({
      where: { id: created.conversationId },
      data: { retainUntil: nearExpiry2, lastActivityAt: new Date(nearExpiry2.getTime() - CHAT_RETENTION_MS) },
    });
    const replyRes = await adminReplyRoute(
      new Request(`${origin}/api/admin/chat/conversations/${created.conversationId}/messages`, {
        method: 'POST',
        headers: { origin, cookie: admin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ clientMessageId: randomUUID(), bodyText: 'Operator reply extends retention' }),
      }),
      { params: Promise.resolve({ id: created.conversationId }) },
    );
    assert.equal(replyRes.status, 200);
    const afterOpReply = await db.chatConversation.findUniqueOrThrow({ where: { id: created.conversationId } });
    assert.ok(afterOpReply.retainUntil.getTime() > nearExpiry2.getTime() + 80 * DAY_MS);
    assert.equal((await createChatRetentionCandidateRepo({ db, now: nearExpiry2 }).summary()).candidateCount, 0);
  });

  test('4) 既有 730d 询盘、分析事件/聚合与审计/设置/备份不纳入候选查询，且前后行内容 hash 不变', async () => {
    const contact = await db.contact.create({
      data: { region: 'US', name: 'Existing Buyer', email: 'inquiry@example.test', normalizedEmail: 'inquiry@example.test' },
    });
    await db.inquiry.create({
      data: {
        ref: `INQ-${process.pid}`,
        replyToken: `tok-${randomUUID()}`,
        contactId: contact.id,
        locale: 'en',
        source: 'FORM',
        message: '730d inquiry message',
        retainUntil: new Date(NOW.getTime() - 10 * DAY_MS),
      },
    });
    await db.analyticsEvent.create({
      data: {
        eventId: randomUUID(),
        semanticKey: `sk-${randomUUID()}`,
        payloadHash: 'a'.repeat(64),
        browserHash: 'b'.repeat(64),
        kind: 'page_view',
        occurredAt: new Date(NOW.getTime() - 40 * DAY_MS),
        receivedAt: new Date(NOW.getTime() - 40 * DAY_MS),
        locale: 'en',
        path: '/en',
      },
    });
    await db.analyticsDaily.create({
      data: {
        localDate: '2025-01-01',
        timezoneRevision: 1,
        timezone: 'UTC',
        dimension: 'site',
        visitors: 1,
        pageViews: 2,
        productViews: 0,
        modelStarts: 0,
        modelSuccesses: 0,
        modelFailures: 0,
        chatStarts: 0,
        durationMsSum: BigInt(0),
        loadDurationSamples: 0,
        aggregatedAt: new Date(NOW.getTime() - 400 * DAY_MS),
        expiresAt: new Date(NOW.getTime() - 10 * DAY_MS),
      },
    });
    await db.analyticsDailyRollup.create({
      data: {
        siteDate: '2025-01-01',
        kind: 'page_view',
        locale: 'en',
        productSlug: '',
        count: 5,
        uniqueBrowsers: 2,
      },
    });
    await db.auditLog.create({
      data: {
        action: 'backup.completed',
        target: 'nbshiyan-daily-sentinel.dump',
        meta: { backupAgeSeconds: 3600, verified: true },
        createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
      },
    });
    await db.siteSetting.create({
      data: {
        key: 'backup.lastStatus',
        value: { verified: true, backupCompletedAt: NOW.toISOString() },
      },
    });

    const beforeHashes = await tableContentHashes();
    const run = await runChatRetention({
      db,
      context: { now: NOW, deadlineAt: new Date(Date.now() + 30_000), signal: new AbortController().signal },
      clock: () => NOW,
    });
    assert.equal(run.kind, 'completed');
    if (run.kind === 'completed') {
      assert.equal(run.status, 'SUCCEEDED');
      assert.deepEqual(run.counts, { candidateCount: 0, deletedCount: 0 });
    }
    assert.deepEqual(await tableContentHashes(), beforeHashes);
  });

  test('5) 并发租约占线返回 409 job_busy；提交时租约被新代次接管则 finish_failed 且不覆写新租约', async () => {
    const until = new Date(NOW.getTime() + 60_000);
    await db.jobState.create({
      data: {
        key: 'chat-retention',
        leaseOwner: 'other-worker',
        generation: 4,
        lockedUntil: until,
        lastStartedAt: NOW,
        lastStatus: 'RUNNING',
      },
    });
    const { createJobServices } = await import('../src/lib/server/composition');
    const handler = createOperationsHandler({
      services: createJobServices({ db, clock: () => NOW }).jobs,
      clock: () => NOW,
      secret: SECRET,
    });
    const busyRes = await handler(new Request(`${origin}/api/admin/cron/operations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobKey: 'chat-retention' }),
    }));
    assert.equal(busyRes.status, 409);
    const held = await db.jobState.findUniqueOrThrow({ where: { key: 'chat-retention' } });
    assert.equal(held.generation, 4);
    assert.equal(held.leaseOwner, 'other-worker');

    // 清空后测试提交阶段租约被新代次抢占
    await db.jobState.deleteMany();
    const takeover = await runChatRetention({
      db,
      context: { now: NOW, deadlineAt: new Date(Date.now() + 30_000), signal: new AbortController().signal },
      clock: () => NOW,
      afterClaim: async (claim) => {
        await db.jobState.update({
          where: { key: 'chat-retention' },
          data: { leaseOwner: 'newer-worker', generation: claim.generation + 1 },
        });
      },
    });
    assert.equal(takeover.kind, 'finish_failed');
    const afterTakeover = await db.jobState.findUniqueOrThrow({ where: { key: 'chat-retention' } });
    assert.equal(afterTakeover.leaseOwner, 'newer-worker');
    assert.equal(afterTakeover.generation, 2);
  });

  test('6) 预存同名 schema 负控：不认领也不破坏已有 schema', async () => {
    const sentinel = `m4t7_${randomBytes(6).toString('hex')}`;
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${sentinel}"`);
    try {
      await owner.$executeRawUnsafe(`CREATE TABLE "${sentinel}"."guard" ("id" int primary key)`);
      await owner.$executeRawUnsafe(`INSERT INTO "${sentinel}"."guard" ("id") VALUES (42)`);
      assert.equal(await createOwnedSchema(owner, sentinel), false);
      const rows = await owner.$queryRawUnsafe<{ id: number }[]>(`SELECT "id" FROM "${sentinel}"."guard"`);
      assert.deepEqual(rows.map((r) => Number(r.id)), [42]);
    } finally {
      await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${sentinel}" CASCADE`);
    }
  });

  test('7) 隔离库注入组合对照：仅授权、仅开策略或双开阶段下均拒绝删除，deletedCount=0 且前后哈希不变', async () => {
    await seedSessionWithConversation({ retainUntil: NOW });
    await seedSessionWithConversation({ retainUntil: new Date(NOW.getTime() + 1) });
    const beforeHashes = await tableContentHashes();

    const { createJobServices } = await import('../src/lib/server/composition');
    const postInjected = async (chatOpts?: {
      retentionDeleteAuthorized?: boolean;
      retentionPolicy?: typeof CHAT_RETENTION_POLICY;
    }, body: Record<string, unknown> = { jobKey: 'chat-retention', dryRun: false }) => {
      const services = createJobServices({
        db,
        clock: () => new Date(NOW),
        ...(chatOpts ? { chat: chatOpts } : {}),
      });
      const handler = createOperationsHandler({ services: services.jobs, clock: () => new Date(NOW), secret: SECRET });
      const res = await handler(new Request(`${origin}/api/admin/cron/operations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      assert.equal(res.status, 200);
      return JobResultDTOSchema.parse(await res.json());
    };

    const baseDry = await postInjected(undefined, { jobKey: 'chat-retention' });
    assert.equal(baseDry.status, 'SUCCEEDED');
    assert.deepEqual(baseDry.counts, { candidateCount: 1, deletedCount: 0 });
    const dryState = await db.jobState.findUniqueOrThrow({ where: { key: 'chat-retention' } });
    const drySucceededAt = dryState.lastSucceededAt?.toISOString();
    assert.ok(drySucceededAt);
    const afterDrySettings = await db.siteSetting.findMany({ orderBy: { key: 'asc' } });

    const cases = [
      { retentionDeleteAuthorized: true },
      { retentionPolicy: { ...CHAT_RETENTION_POLICY, cleanupEnabled: true } },
      { retentionDeleteAuthorized: true, retentionPolicy: { ...CHAT_RETENTION_POLICY, cleanupEnabled: true } },
    ];
    for (const chatOpts of cases) {
      const body = await postInjected(chatOpts);
      assert.equal(body.status, 'FAILED');
      assert.deepEqual(body.counts, { candidateCount: 1, deletedCount: 0 });
      const state = await db.jobState.findUniqueOrThrow({ where: { key: 'chat-retention' } });
      assert.equal(state.lastStatus, 'FAILED');
      assert.equal(state.lastErrorCode, 'forbidden');
      assert.equal(state.lastSucceededAt?.toISOString(), drySucceededAt);
    }

    assert.deepEqual(await tableContentHashes(), beforeHashes);
    assert.deepEqual(await db.siteSetting.findMany({ orderBy: { key: 'asc' } }), afterDrySettings);
  });
});
