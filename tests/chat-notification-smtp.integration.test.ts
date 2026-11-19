import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { createNotificationMailer, notificationMailConfig } from '../src/lib/server/chat/notification-mailer';
import { createNotificationRepo } from '../src/lib/server/chat/notification-repo';
import { processChatNotifications, NotificationPreSendFailure } from '../src/lib/server/chat/notification-service';
import { CHAT_NOTIFICATION_LEASE_MS, CHAT_SMTP_DEADLINE_MS } from '../src/lib/server/chat/notification-policy';

const required = process.env.M4T4_SMTP_EVIDENCE === '1';
const stateUrl = 'http://127.0.0.1:3998';
const require = createRequire(import.meta.url);
let db: PrismaClient | undefined;
let admin: PrismaClient | undefined;
let schema: string | undefined;
let owned = false;

function namespaceDatabase() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.SMTP_EVIDENCE_MODE, 'http-real');
  assert.ok(process.getuid!() > 0);
  const owner = JSON.parse(readFileSync(`${process.env.SMTP_EVIDENCE_ROOT}/owner.json`, 'utf8'));
  assert.notEqual(readlinkSync('/proc/self/ns/net'), owner.hostNetNamespace);
  assert.notEqual(readlinkSync('/proc/self/ns/pid'), owner.hostPidNamespace);
  const addresses = readFileSync('/proc/self/net/dev', 'utf8').split('\n').filter((line) => line.includes(':')).map((line) => line.split(':')[0].trim());
  assert.deepEqual(addresses, ['lo']);
  assert.equal(process.env.SMTP_HOST, 'smtp.evidence.test');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mail_evidence') throw new Error('isolated database required');
  return url;
}
async function arm(action: string) {
  const response = await fetch(`${stateUrl}/chat/${action}`, {
    method: 'POST', headers: { 'x-mail-evidence-control': process.env.SMTP_EVIDENCE_CONTROL ?? '' }, signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200); await response.body?.cancel();
}
async function stats() {
  const result = await fetch(`${stateUrl}/stats`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(result.status, 200);
  return await result.json() as { received: number; rcptAttempts: number; rcptFailures: number; chatEvidence: { acceptedIds: string[]; dataEnds: number; dataCloses: number } };
}
async function seed(attempts = 0) {
  const client = db!;
  const now = new Date(), later = new Date(now.getTime() + 86_400_000), visitor = randomUUID();
  const conversation = randomUUID(), msg = randomUUID();
  await client.chatVisitorSession.create({ data: { id: visitor, tokenHash: createHash('sha256').update(visitor).digest('hex'), createdAt: now, lastActivityAt: now, absoluteExpiresAt: later } });
  await client.chatConversation.create({ data: { id: conversation, visitorSessionId: visitor, clientConversationId: randomUUID(), createPayloadHash: 'a'.repeat(64), locale: 'en', lastSeq: 1, createdAt: now, updatedAt: now, lastActivityAt: now, retainUntil: later } });
  await client.chatMessage.create({ data: { id: msg, conversationId: conversation, seq: 1, sender: 'VISITOR', clientMessageId: randomUUID(), payloadHash: 'b'.repeat(64), bodyText: 'fixture body never sent', createdAt: now } });
  return client.chatNotification.create({ data: { id: randomUUID(), conversationId: conversation, messageId: msg, attempts, stableMessageId: `${msg}@smtp.example.test`, availableAt: now, createdAt: now, updatedAt: now } });
}
function config(port: '465' | '587') {
  const cfg = notificationMailConfig({ ...process.env, SMTP_PORT: port, NEXT_PUBLIC_SITE_URL: 'https://example.test' });
  assert.ok(cfg);
  return cfg;
}
async function run(clock: () => Date, deps: { port: '465' | '587'; beforeSend?: () => Promise<void> }) {
  const budget = { deadlineAt: new Date(Date.now() + 54_750), signal: new AbortController().signal };
  const repo = createNotificationRepo({ db: db!, clock, budget, env: {} });
  const mailer = createNotificationMailer(config(deps.port));
  let called = 0, sendMs = 0;
  await processChatNotifications({ repo, owner: 'smtp-fixture', limit: 1, beforeSend: deps.beforeSend,
    getMailer: async () => ({ async send(msg, signal) {
      called++;
      const started = performance.now();
      try { return await mailer.send(msg, signal); } finally { sendMs = performance.now() - started; }
    } }), env: {},
  }, { now: clock(), budget });
  return { called, sendMs };
}

async function assertUntrustedCertificate(port: '465' | '587') {
  const host = 'smtp.example.test';
  const root = mkdtempSync(join(tmpdir(), 'm4t4-smtp-self-signed-'));
  try {
    const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', 'key.pem', '-out', 'cert.pem'],
    { cwd: root, stdio: 'ignore', timeout: 15_000 });
    assert.equal(cert.status, 0, 'ephemeral SMTP TLS certificate generation failed');
    const secureContext = createSecureContext({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) });
    const seen = { connections: 0, handshake: 0, starttls: 0, auth: 0, mail: 0 };
    const peers = new Set<Socket>();
    function serve(socket: Socket, cleartext: boolean) {
      let pending = '';
      const onData = (chunk: Buffer) => {
        pending += chunk.toString();
        while (pending.includes('\r\n')) {
          const end = pending.indexOf('\r\n');
          const verb = pending.slice(0, end).split(' ', 1)[0].toUpperCase();
          pending = pending.slice(end + 2);
          if (verb === 'EHLO') socket.write(cleartext ? '250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n' : '250-localhost\r\n250 AUTH PLAIN\r\n');
          else if (verb === 'STARTTLS' && cleartext) {
            seen.starttls++;
            socket.off('data', onData);
            socket.write('220 Ready to start TLS\r\n');
            upgrade(socket, false);
            return;
          } else if (verb === 'AUTH') { seen.auth++; socket.write('235 Authentication successful\r\n'); }
          else if (verb === 'MAIL') { seen.mail++; socket.write('550 Test sink rejects all mail\r\n'); }
          else socket.write('500 Unexpected command\r\n');
        }
      };
      socket.on('data', onData);
    }
    function upgrade(socket: Socket, greet: boolean) {
      const tls = new TLSSocket(socket, { isServer: true, secureContext });
      peers.add(tls);
      tls.on('error', () => {});
      tls.once('secure', () => {
        seen.handshake++;
        serve(tls, false);
        if (greet) tls.write('220 localhost SMTP\r\n');
      });
    }
    const server = createServer((socket) => {
      peers.add(socket);
      socket.on('error', () => {});
      seen.connections++;
      if (port === '465') upgrade(socket, true);
      else { serve(socket, true); socket.write('220 localhost SMTP\r\n'); }
    });
    try {
      await once(server.listen(0, '127.0.0.1'), 'listening');
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const cfg = notificationMailConfig({ SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: 'fixture', SMTP_PASS: 'fixture',
        MAIL_FROM: 'sender@example.test', NEXT_PUBLIC_SITE_URL: 'https://example.test', CHAT_NOTIFICATION_TO: 'ops@example.test' });
      assert.ok(cfg);
      const mailer = createNotificationMailer(cfg, { connect: (options) => {
        assert.equal(options.host, host); assert.equal(options.port, Number(port));
        return createConnection({ host: '127.0.0.1', port: address.port, signal: options.signal });
      } });
      const result = await mailer.send({ stableMessageId: 'tls-probe@example.test', conversationId: 'test-only', locale: 'en', receivedAt: new Date() }, new AbortController().signal);
      assert.deepEqual(result, { kind: 'failed', code: 'CHAT_SMTP_TLS' });
      assert.deepEqual(seen, { connections: 1, handshake: 0, starttls: port === '587' ? 1 : 0, auth: 0, mail: 0 });
      console.log(`M4T4_TLS_REJECT port=${port} code=CHAT_SMTP_TLS auth=0 mail=0`);
    } finally {
      for (const socket of peers) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally { rmSync(root, { recursive: true }); }
}

async function crashAfterAcceptance() {
  const url = namespaceDatabase();
  assert.match(url.searchParams.get('schema') ?? '', /^chatnotify_\d+_[a-f0-9]{8}$/);
  const client = new PrismaClient({ datasources: { db: { url: url.href } } });
  try {
    const clock = () => new Date();
    const budget = { deadlineAt: new Date(Date.now() + 54_750), signal: new AbortController().signal };
    await processChatNotifications({ repo: createNotificationRepo({ db: client, clock, budget, env: {} }), owner: 'crash-fixture',
      limit: 1, env: {}, getMailer: async () => createNotificationMailer(config('465')),
      afterAccepted: async () => { process.kill(process.pid, 'SIGKILL'); await new Promise<never>(() => {}); },
    }, { now: clock(), budget });
  } finally { await client.$disconnect(); }
  throw new Error('accepted-mail fault injection not reached');
}

if (required && process.env.M4T4_SMTP_CRASH_WORKER === '1') {
  void crashAfterAcceptance().catch(() => { process.exitCode = 1; });
} else {
// Opt in only through local-smtp's private CI namespace. Missing prerequisites there fail the job.
describe('M4-T4 isolated TLS SMTP and durable writes', { skip: !required && 'private SMTP evidence namespace unavailable', timeout: 120_000 }, () => {
  before(async () => {
    const url = namespaceDatabase();
    admin = new PrismaClient({ datasources: { db: { url: url.href } } });
    schema = `chatnotify_${process.pid}_${randomBytes(4).toString('hex')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); owned = true;
    url.searchParams.set('schema', schema);
    const setup = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url.href }, timeout: 60_000 });
    assert.equal(setup.status, 0, 'private schema initialization failed');
    db = new PrismaClient({ datasources: { db: { url: url.href } } });
  });
  after(async () => {
    await db?.$disconnect();
    if (owned && admin && schema) { assert.match(schema, /^chatnotify_\d+_[a-f0-9]{8}$/); await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); }
    await admin?.$disconnect();
  });

  test('AC2c: implicit TLS accepts at about 19s and the current lease commits SENT', async () => {
    await assertUntrustedCertificate('465');
    const row = await seed(); await arm('delay');
    const before = await stats();
    const result = await run(() => new Date(), { port: '465' });
    const saved = await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
    assert.ok(result.sendMs >= 18_900 && result.sendMs < CHAT_SMTP_DEADLINE_MS);
    assert.equal(result.called, 1); assert.equal(saved.status, 'SENT'); assert.equal(saved.attempts, 1);
    assert.ok(saved.sentAt && saved.requestStartedAt && saved.sentAt.getTime() - saved.requestStartedAt.getTime() < CHAT_NOTIFICATION_LEASE_MS);
    assert.equal(saved.leaseOwner, null); assert.equal(saved.lastErrorCode, null);
    const after = await stats(); assert.equal(after.received - before.received, 1);
    assert.ok(after.chatEvidence.acceptedIds.includes(`<${row.stableMessageId}>`));
  });

  test('AC2d: busy DATA over 20s destroys the STARTTLS socket and writes UNKNOWN without sweep', async () => {
    await assertUntrustedCertificate('587');
    const row = await seed(); await arm('slow'); const before = await stats();
    const result = await run(() => new Date(), { port: '587' });
    const saved = await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(result.called, 1);
    assert.ok(result.sendMs >= CHAT_SMTP_DEADLINE_MS - 100 && result.sendMs <= CHAT_SMTP_DEADLINE_MS + 2000);
    assert.equal(saved.status, 'UNKNOWN'); assert.equal(saved.attempts, 1); assert.equal(saved.lastErrorCode, 'CHAT_SMTP_DEADLINE');
    assert.equal(saved.availableAt.getTime(), saved.updatedAt.getTime() + 60_000);
    assert.ok(saved.requestStartedAt && saved.updatedAt.getTime() - saved.requestStartedAt.getTime() < CHAT_NOTIFICATION_LEASE_MS);
    assert.equal(saved.leaseOwner, null); assert.equal(saved.lockedUntil, null);
    let after = await stats();
    for (let n = 0; n < 20 && after.chatEvidence.dataCloses === before.chatEvidence.dataCloses; n++) { await delay(100); after = await stats(); }
    assert.equal(after.chatEvidence.dataEnds - before.chatEvidence.dataEnds, 1);
    assert.equal(after.chatEvidence.dataCloses - before.chatEvidence.dataCloses, 1);
    assert.equal(after.received, before.received);
    assert.deepEqual(await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } }), saved);
    await db!.chatNotification.delete({ where: { id: row.id } });
  });

  test('PM-P2: abrupt close after DATA on the last attempt preserves cap UNKNOWN and due value', async () => {
    const row = await seed(3); await arm('reset'); const before = await stats();
    assert.equal((await run(() => new Date(), { port: '465' })).called, 1);
    const saved = await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(saved.status, 'UNKNOWN'); assert.equal(saved.attempts, 4); assert.equal(saved.lastErrorCode, 'CHAT_SMTP_UNKNOWN');
    assert.equal(saved.availableAt.getTime(), row.availableAt.getTime());
    assert.equal((await stats()).chatEvidence.dataEnds - before.chatEvidence.dataEnds, 1);
    assert.equal((await run(() => new Date(Date.now() + 24 * 3600_000), { port: '465' })).called, 0);
  });

  test('AC4/AC16: continuous 451 and fourth pre-adapter failure leave 4/4 and 4/3 with safe codes', async () => {
    for (const fourthSuppressed of [false, true]) {
      const row = await seed(); await arm(fourthSuppressed ? 'rcpt-3' : 'rcpt-4'); const before = await stats();
      let now = Date.now(), count = 0;
      for (let n = 1; n <= 4; n++) {
        const previous = await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
        const result = await run(() => new Date(now), { port: '465', beforeSend: fourthSuppressed && n === 4 ? async () => { throw new NotificationPreSendFailure(); } : undefined });
        count += result.called;
        const rowAfter = await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
        assert.equal(rowAfter.attempts, n); assert.equal(rowAfter.status, n === 4 ? 'FAILED' : 'QUEUED');
        if (n === 4) assert.equal(rowAfter.availableAt.getTime(), previous.availableAt.getTime());
        assert.match(rowAfter.lastErrorCode ?? '', /^CHAT_(SMTP_TEMPORARY|PRE_SEND_FAULT)$/);
        now = rowAfter.availableAt.getTime();
      }
      const after = await stats(), wanted = fourthSuppressed ? 3 : 4;
      assert.equal(count, wanted); assert.equal(after.rcptAttempts - before.rcptAttempts, wanted);
      assert.equal(after.rcptFailures - before.rcptFailures, wanted); assert.equal(after.received, before.received);
      assert.equal((await run(() => new Date(now + 86_400_000), { port: '465' })).called, 0);
    }
  });

  test('AC5: accepted fourth delivery killed before writeback sweeps to capped UNKNOWN', async () => {
    const row = await seed(3);
    const before = await stats();
    const url = namespaceDatabase(); url.searchParams.set('schema', schema!);
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env: { ...process.env, DATABASE_URL: url.href, M4T4_SMTP_CRASH_WORKER: '1' }, stdio: 'ignore',
    });
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    try {
      const [exit, signal] = await once(child, 'exit');
      assert.equal(timedOut, false); assert.equal(exit, null); assert.equal(signal, 'SIGKILL');
    } finally { clearTimeout(watchdog); }
    const interrupted = await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(interrupted.status, 'SENDING'); assert.equal(interrupted.attempts, 4); assert.ok(interrupted.requestStartedAt && interrupted.lockedUntil);
    const after = await stats();
    assert.equal(after.received - before.received, 1);
    assert.ok(after.chatEvidence.acceptedIds.includes(`<${row.stableMessageId}>`));
    const sweepClock = () => interrupted.lockedUntil!;
    const repo = createNotificationRepo({ db: db!, clock: sweepClock, env: {} });
    assert.equal(await repo.recoverExpiredLease(sweepClock()), 1);
    const expired = await db!.chatNotification.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(expired.status, 'UNKNOWN'); assert.equal(expired.availableAt.getTime(), row.availableAt.getTime());
    assert.equal(expired.sentAt, null); assert.equal(expired.attempts, 4);
    assert.equal((await run(() => new Date(Date.now() + 86_400_000), { port: '465' })).called, 0);
  });
});
}
