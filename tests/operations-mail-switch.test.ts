// M5-T4 O1 回归：operations 通用作业入口对 mail-queue 必须与 mailApiEnabled 同开关。
//
// 只用纯 mock registry + 计数探针验证“拒绝发生在前”：不连 DB/SMTP、不监听端口、不发外网。
// 危险格：NEXT_PUBLIC_ADMIN_MAIL 关闭、但 SMTP 配置完整时，真实队列会拿到 SMTP adapter。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobRegistry,
  createOperationsHandler,
  type RegisteredJob,
} from '../src/lib/server/jobs/registry';
import { mailApiEnabled, mockAdapterAllowed, smtpConfig } from '../src/lib/server/mail/config';

const SECRET = 'o1-operations-mail-switch-test-secret';
const NOW = new Date('2026-03-01T10:00:00.000Z');

const MAIL_ENV_KEYS = [
  'NEXT_PUBLIC_ADMIN_MAIL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'REPLY_DOMAIN',
  'MAIL_SEND_ADAPTER',
  'APP_ENV',
  'NODE_TLS_REJECT_UNAUTHORIZED',
] as const;

type MailEnvKey = (typeof MAIL_ENV_KEYS)[number];
type MailEnv = Partial<Record<MailEnvKey, string>>;

/** SMTP 完整配置：smtpConfig().ok 为真，用来复现“开关关闭但 adapter 可创建”的危险格。 */
const SMTP_COMPLETE: MailEnv = {
  SMTP_HOST: 'smtp.mail.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'operations-switch',
  SMTP_PASS: 'not-a-real-password',
  MAIL_FROM: 'PackJoyU <no-reply@packjoy.example>',
  REPLY_DOMAIN: 'reply.packjoy.example',
};

function applyEnv(vars: MailEnv) {
  for (const key of MAIL_ENV_KEYS) {
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** 逐测试恢复环境，避免开关状态泄漏到后续用例。 */
async function withEnv<T>(vars: MailEnv, work: () => Promise<T>): Promise<T> {
  const saved = MAIL_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  applyEnv(vars);
  try {
    return await work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function post(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  return new Request('http://127.0.0.1/api/admin/cron/operations', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

type Probes = { run: number; adapter: number };

/** mail-queue 探针：run 被调用就会走一次“adapter 发送”，用来证明两处都没有被触达。 */
function mailProbeJob(probes: Probes): RegisteredJob {
  return {
    key: 'mail-queue',
    async run() {
      probes.run += 1;
      await Promise.resolve();
      probes.adapter += 1;
      return { kind: 'ran', status: 'SUCCEEDED', counts: { sent: 1 } };
    },
  };
}

function ranJob(key: RegisteredJob['key'], counts: Record<string, number> = {}): RegisteredJob {
  return {
    key,
    async run() {
      return { kind: 'ran', status: 'SUCCEEDED', counts };
    },
  };
}

function handlerFor(probes: Probes, extraJobs: RegisteredJob[] = []) {
  return createOperationsHandler({
    services: createJobRegistry([mailProbeJob(probes), ...extraJobs]),
    clock: () => new Date(NOW),
    secret: SECRET,
  });
}

describe('M5-T4 O1 operations 邮件开关', { concurrency: false, timeout: 30_000 }, () => {
  test('危险格基线：开关关闭但 SMTP 完整（smtpConfig().ok=true、mailApiEnabled=false）', async () => {
    await withEnv({ NEXT_PUBLIC_ADMIN_MAIL: 'off', ...SMTP_COMPLETE }, async () => {
      assert.equal(mailApiEnabled(), false);
      assert.equal(smtpConfig().ok, true);
    });
  });

  test('off+SMTP 完整：mail-queue 返回 404 not_found，job.run 与 adapter 均不调用', async () => {
    await withEnv({ NEXT_PUBLIC_ADMIN_MAIL: 'off', ...SMTP_COMPLETE }, async () => {
      const probes: Probes = { run: 0, adapter: 0 };
      const res = await handlerFor(probes)(post({ jobKey: 'mail-queue' }));
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'not_found' });
      assert.equal(probes.run, 0, 'job.run 不得被调用');
      assert.equal(probes.adapter, 0, 'adapter 发送不得被调用');
    });
  });

  test('off+mock 意图：同样 404，job.run 与 adapter 均不调用', async () => {
    await withEnv(
      { NEXT_PUBLIC_ADMIN_MAIL: 'off', ...SMTP_COMPLETE, MAIL_SEND_ADAPTER: 'mock', APP_ENV: 'test' },
      async () => {
        assert.equal(mockAdapterAllowed(), true);
        const probes: Probes = { run: 0, adapter: 0 };
        const res = await handlerFor(probes)(post({ jobKey: 'mail-queue' }));
        assert.equal(res.status, 404);
        assert.equal(probes.run, 0);
        assert.equal(probes.adapter, 0);
      },
    );
  });

  test('http：mail-queue 仍正常执行并透传计数', async () => {
    await withEnv({ NEXT_PUBLIC_ADMIN_MAIL: 'http', ...SMTP_COMPLETE }, async () => {
      assert.equal(mailApiEnabled(), true);
      const probes: Probes = { run: 0, adapter: 0 };
      const res = await handlerFor(probes)(post({ jobKey: 'mail-queue' }));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { jobKey?: string; status?: string; counts?: { sent?: number } };
      assert.equal(body.jobKey, 'mail-queue');
      assert.equal(body.status, 'SUCCEEDED');
      assert.equal(body.counts?.sent, 1);
      assert.equal(probes.run, 1);
      assert.equal(probes.adapter, 1);
    });
  });

  test('邮件关闭时 analytics 两作业照常执行', async () => {
    await withEnv({ NEXT_PUBLIC_ADMIN_MAIL: 'off', ...SMTP_COMPLETE }, async () => {
      const probes: Probes = { run: 0, adapter: 0 };
      const handle = handlerFor(probes, [
        ranJob('analytics-aggregate', { candidateCount: 2 }),
        ranJob('analytics-retention', { candidateCount: 0, deletedCount: 0 }),
      ]);
      const aggregate = await handle(post({ jobKey: 'analytics-aggregate' }));
      assert.equal(aggregate.status, 200);
      const retention = await handle(post({ jobKey: 'analytics-retention', dryRun: true }));
      assert.equal(retention.status, 200);
      assert.equal(probes.run, 0);
      assert.equal(probes.adapter, 0);
    });
  });

  test('鉴权失败仍是 401，且先于开关判定', async () => {
    await withEnv({ NEXT_PUBLIC_ADMIN_MAIL: 'off', ...SMTP_COMPLETE }, async () => {
      const probes: Probes = { run: 0, adapter: 0 };
      const handle = handlerFor(probes);
      assert.equal((await handle(post({ jobKey: 'mail-queue' }, null))).status, 401);
      assert.equal((await handle(post({ jobKey: 'mail-queue' }, 'Bearer wrong'))).status, 401);
      assert.equal(probes.run, 0);
      assert.equal(probes.adapter, 0);
    });
  });

  test('无效体/未注册 key 仍是 400', async () => {
    await withEnv({ NEXT_PUBLIC_ADMIN_MAIL: 'off', ...SMTP_COMPLETE }, async () => {
      const handle = handlerFor({ run: 0, adapter: 0 });
      assert.equal((await handle(post({ jobKey: 'chat-notifications' }))).status, 400);
      assert.equal((await handle(post({ jobKey: 'mail-queue', extra: 1 }))).status, 400);
      const invalidJson = new Request('http://127.0.0.1/api/admin/cron/operations', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: '{',
      });
      assert.equal((await handle(invalidJson)).status, 400);
    });
  });

  test('既有 busy/failed 映射不变（非邮件作业）', async () => {
    await withEnv({ NEXT_PUBLIC_ADMIN_MAIL: 'off', ...SMTP_COMPLETE }, async () => {
      const probes: Probes = { run: 0, adapter: 0 };
      const busy = createOperationsHandler({
        services: createJobRegistry([
          mailProbeJob(probes),
          { key: 'analytics-aggregate', async run() { return { kind: 'busy' }; } },
        ]),
        clock: () => new Date(NOW),
        secret: SECRET,
      });
      assert.equal((await busy(post({ jobKey: 'analytics-aggregate' }))).status, 409);
      const failed = createOperationsHandler({
        services: createJobRegistry([
          mailProbeJob(probes),
          { key: 'analytics-aggregate', async run() { throw new Error('boom'); } },
        ]),
        clock: () => new Date(NOW),
        secret: SECRET,
      });
      assert.equal((await failed(post({ jobKey: 'analytics-aggregate' }))).status, 500);
      assert.equal(probes.run, 0);
    });
  });
});
