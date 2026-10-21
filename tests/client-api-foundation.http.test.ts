import http from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountDTOSchema,
  AnalyticsReceiptDTOSchema,
  ConsentDTOSchema,
  MessageReceivedDTOSchema,
  OpsReportReceiptDTOSchema,
} from '../src/lib/contracts/index';
import { adaptApiError } from '../src/lib/client/api-errors';
import {
  CLIENT_DEADLINE_MS,
  MESSAGE_RETRY_DELAYS_MS,
  RESPONSE_JSON_MAX_BYTES,
  isAuthJsPath,
  requestApi,
  retryPlanFor,
  type ClientApiFailure,
  type ClientApiResult,
  type ClientTransport,
} from '../src/lib/client/api';

const SENTINEL = 'SENSITIVE_STACK_LINE';
const UUID = '5fcf5ba2-7d35-4d50-8798-e6f65b1268ef';
const OTHER = '7aac1bb7-f310-40e2-bf11-1252744ab7e5';
const AT = '2026-10-19T16:20:00.000Z';
const UNTIL = '2026-10-19T18:20:00.000Z';
const MESSAGE_PATH = '/api/chat/conversations/cm_example/messages';

const account = {
  id: 'user_1',
  name: null,
  email: 'admin@example.com',
  role: 'ADMIN',
  passwordlessEnabled: false,
  totpEnabled: true,
  currentDevice: {
    id: 'device_1',
    current: true,
    remembered: false,
    createdAt: AT,
    lastActivityAt: AT,
    effectiveExpiresAt: UNTIL,
    absoluteExpiresAt: null,
    revokedAt: null,
    deviceLabel: null,
  },
};

const received = {
  message: {
    id: 'cm_example_message',
    seq: 3,
    sender: 'VISITOR',
    bodyText: 'Can you make this box in blue?',
    createdAt: AT,
  },
  receivedAt: AT,
  duplicate: false,
};

const receipt = { acceptedIds: [UUID], duplicateIds: [], receivedAt: AT };
const consentOff = { analytics: false, expiresAt: null };
const opsReceipt = { accepted: true, measuredAt: AT };

type Hit = { method: string; url: string; body: string; init: RequestInit; at: number };

function fail(result: ClientApiResult<unknown>): ClientApiFailure {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected a failure result');
  return result;
}

function absent(value: unknown) {
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes(SENTINEL), false);
  assert.equal(encoded.includes('Expected'), false);
  assert.equal(encoded.includes('ZodError'), false);
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw), ...headers });
  res.end(raw);
}

async function withServer(
  onRequest: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  run: (transport: ClientTransport, hits: Hit[]) => Promise<void>,
) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('error', () => { if (!res.writableEnded) res.end(); });
    res.on('error', () => undefined);
    req.on('end', () => onRequest(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  const transport: ClientTransport = (path, init) => {
    hits.push({
      method: String(init.method ?? 'GET'),
      url: path,
      body: typeof init.body === 'string' ? init.body : '',
      init,
      at: Date.now(),
    });
    return fetch(new URL(path, `http://127.0.0.1:${port}`), init);
  };
  try {
    await run(transport, hits);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
}

test('retry plans follow the path, not the caller flag', () => {
  assert.deepEqual(MESSAGE_RETRY_DELAYS_MS, [1_000, 2_000, 4_000]);
  assert.equal(CLIENT_DEADLINE_MS, 15_000);
  const auto = { delaysMs: MESSAGE_RETRY_DELAYS_MS, explicitReread: true };
  assert.deepEqual(retryPlanFor('POST', MESSAGE_PATH), auto);
  assert.deepEqual(retryPlanFor('POST', '/api/chat/conversations'), auto);
  assert.deepEqual(retryPlanFor('POST', '/api/admin/chat/conversations/thread_1/messages'), auto);
  assert.deepEqual(retryPlanFor('POST', '/api/chat/conversations/thread_1/read'), auto);
  assert.deepEqual(retryPlanFor('POST', '/api/admin/chat/conversations/thread_1/read'), auto);
  assert.deepEqual(retryPlanFor('POST', '/api/analytics/events', true), auto);
  assert.deepEqual(retryPlanFor('GET', '/api/admin/account'), { delaysMs: [], explicitReread: true });
  assert.deepEqual(retryPlanFor('HEAD', '/api/admin/stats'), { delaysMs: [], explicitReread: true });
  assert.deepEqual(retryPlanFor('GET', '/api/admin/cron/mail-queue'), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/admin/cron/operations', true), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/admin/account/reauth', true), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/auth-admin/recovery/start', true), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/auth-admin/recovery/confirm', true), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/chat/session', true), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('PATCH', '/api/admin/chat/conversations/thread_1', true), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('PATCH', '/api/admin/settings/analytics'), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/analytics/consent'), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/analytics/consent', true), { delaysMs: [0], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/auth-admin/recovery/enroll'), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/auth-admin/recovery/enroll', true), { delaysMs: [0], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/internal/ops-report'), { delaysMs: [0], explicitReread: false });
  assert.equal(isAuthJsPath('/api/auth/callback/credentials'), true);
  assert.equal(isAuthJsPath('/api/auth'), true);
  assert.equal(isAuthJsPath('/api/auth-admin/recovery/enroll'), false);
  assert.equal(retryPlanFor('POST', '/api/auth/callback/credentials', true).explicitReread, false);
});

test('a named DTO is returned as parsed output and an ok/data wrapper is not unwrapped', async () => {
  let step = 0;
  await withServer((_req, res) => {
    step += 1;
    if (step === 1) {
      send(res, 200, {
        ...received,
        message: { ...received.message, bodyText: '  Can you make this box in blue?  ' },
      });
      return;
    }
    send(res, 200, { ok: true, data: account, stack: SENTINEL });
  }, async (transport, hits) => {
    const success = await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'Can you make this box in blue?' },
      schema: MessageReceivedDTOSchema,
      transport,
    });
    assert.equal(success.ok, true);
    if (!success.ok) return;
    assert.equal(success.attempts, 1);
    assert.equal(success.data.message.bodyText, 'Can you make this box in blue?');
    assert.deepEqual(success.data, received);
    const hit = hits[0];
    assert.equal(hit.init.credentials, 'same-origin');
    assert.equal(hit.init.cache, 'no-store');
    assert.equal(hit.init.redirect, 'error');
    const headers = new Headers(hit.init.headers);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('authorization'), null);
    const wrapped = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, transport }));
    assert.equal('data' in wrapped, false);
    assert.equal(wrapped.text.includes('admin@example.com'), false);
    absent(wrapped);
  });
});

test('invalid JSON and a schema miss do not echo parser text', async () => {
  let step = 0;
  await withServer((_req, res) => {
    step += 1;
    if (step === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{${SENTINEL}`);
      return;
    }
    send(res, 200, { hello: SENTINEL, message: SENTINEL });
  }, async (transport) => {
    const invalid = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, transport }));
    const missed = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, transport }));
    absent(invalid);
    absent(missed);
    assert.equal(invalid.code, undefined);
    assert.equal(missed.code, undefined);
  });
});

test('field errors keep only controlled messages and unknown bodies hide stack and message', async () => {
  await withServer((_req, res) => {
    send(res, 400, {
      error: 'invalid',
      requestId: UUID,
      fieldErrors: {
        email: 'Use a valid email.',
        bodyText: 'Visible note',
        role: 'ADMIN',
        passwordHash: 'secret-hash',
        message: SENTINEL,
        stack: SENTINEL,
        totp: 'bad\ncode',
        clientMessageId: '',
        limit: 'x'.repeat(201),
      },
      stack: SENTINEL,
      message: SENTINEL,
    });
  }, async (transport, hits) => {
    const result = fail(await requestApi({
      path: '/api/chat/conversations',
      method: 'POST',
      body: { clientConversationId: UUID, clientMessageId: OTHER, locale: 'en', bodyText: 'Hello' },
      schema: MessageReceivedDTOSchema,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.equal(result.envelope, 'app');
    assert.equal(result.code, 'invalid');
    assert.equal(result.action, 'inline');
    assert.equal(result.requestId, UUID);
    assert.deepEqual(result.fieldErrors, { email: 'Use a valid email.', bodyText: 'Visible note' });
    assert.match(result.text, /Check the highlighted fields\./);
    assert.match(result.text, new RegExp(`Reference: ${UUID}`));
    absent(result);
    assert.equal(result.text.includes('secret-hash'), false);
    assert.equal(result.text.includes('ADMIN'), false);
  });
});

test('legacy unauthorized, forbidden, and conflict responses are not replayed', async () => {
  const cases = [
    { status: 401, body: { error: 'unauthorized', stack: SENTINEL }, audience: 'admin' as const, action: 'login', envelope: 'legacy' },
    { status: 401, body: { error: 'unauthorized' }, audience: 'visitor' as const, action: 'stop', envelope: 'legacy' },
    { status: 403, body: { error: 'forbidden', requestId: UUID, message: SENTINEL }, audience: 'admin' as const, action: 'stop', envelope: 'app' },
    { status: 409, body: { error: 'idempotency_conflict', requestId: UUID, stack: SENTINEL }, audience: 'visitor' as const, action: 'stop', envelope: 'app' },
    { status: 409, body: { error: 'conversation_closed', requestId: UUID }, audience: 'visitor' as const, action: 'stop', envelope: 'app' },
  ];
  let step = 0;
  await withServer((_req, res) => {
    const item = cases[step];
    step += 1;
    send(res, item.status, item.body);
  }, async (transport, hits) => {
    for (const item of cases) {
      const before = hits.length;
      const result = fail(await requestApi({
        path: item.status === 401 ? '/api/admin/account' : MESSAGE_PATH,
        method: item.status === 401 ? 'GET' : 'POST',
        body: item.status === 401 ? undefined : { clientMessageId: OTHER, bodyText: 'Hello' },
        schema: AccountDTOSchema,
        audience: item.audience,
        transport,
      }));
      assert.equal(hits.length - before, 1, String(item.status));
      assert.equal(result.action, item.action);
      assert.equal(result.envelope, item.envelope);
      assert.equal(result.code, item.body.error);
      assert.equal(result.retryable, false);
      assert.equal(result.attempts, 1);
      absent(result);
    }
    assert.match(hits[0].url, /\/api\/admin\/account/);
  });
});

test('admin and visitor legacy 401 use different recovery actions', async () => {
  let step = 0;
  await withServer((_req, res) => {
    step += 1;
    send(res, 401, { error: 'unauthorized', message: SENTINEL });
  }, async (transport) => {
    const admin = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, audience: 'admin', transport }));
    const visitor = fail(await requestApi({ path: '/api/chat/conversations/thread_1', schema: AccountDTOSchema, transport }));
    assert.equal(admin.action, 'login');
    assert.match(admin.text, /Sign in again/);
    assert.equal(visitor.action, 'stop');
    assert.match(visitor.text, /no longer valid/);
    assert.equal(admin.requestId, undefined);
    assert.equal(step, 2);
    absent(admin);
    absent(visitor);
  });
});

test('a safe GET marks 503 and 408 for an explicit re-read and does not loop', async () => {
  let step = 0;
  await withServer((_req, res) => {
    step += 1;
    send(res, step === 1 ? 503 : 408, { error: step === 1 ? 'service_unavailable' : 'timeout', requestId: UUID, stack: SENTINEL });
  }, async (transport, hits) => {
    const down = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, audience: 'admin', transport }));
    const again = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, audience: 'admin', transport }));
    assert.equal(hits.length, 2);
    assert.equal(down.attempts, 1);
    assert.equal(down.action, 'retry');
    assert.equal(down.retryable, true);
    assert.equal(down.code, 'service_unavailable');
    assert.match(down.text, /Reference: /);
    assert.equal(again.attempts, 1);
    assert.equal(again.retryable, true);
    absent(down);
  });
});

test('Russian copy is used for a safe GET failure', async () => {
  await withServer((_req, res) => {
    send(res, 503, { error: 'service_unavailable', requestId: UUID });
  }, async (transport) => {
    const result = fail(await requestApi({
      path: '/api/admin/stats',
      schema: AccountDTOSchema,
      locale: 'ru',
      audience: 'admin',
      transport,
    }));
    assert.match(result.text, /Сервис временно недоступен\./);
    assert.match(result.text, new RegExp(`Номер: ${UUID}`));
    assert.equal(result.text.includes('temporarily'), false);
  });
});

test('cron GET and one-shot writes do not replay an unknown 503', async () => {
  const calls = [
    { path: '/api/admin/account/reauth', method: 'POST' as const, body: { purpose: 'DEVICE_REVOKE' }, boundedRetry: true },
    { path: '/api/auth-admin/recovery/start', method: 'POST' as const, body: { email: 'admin@example.com' }, boundedRetry: true },
    { path: '/api/auth-admin/recovery/confirm', method: 'POST' as const, body: { totp: '001234' }, boundedRetry: true },
    { path: '/api/admin/account/session/activity', method: 'POST' as const, body: {}, boundedRetry: true },
    { path: '/api/chat/session', method: 'POST' as const, body: { locale: 'en' }, boundedRetry: true },
    { path: '/api/admin/cron/operations', method: 'POST' as const, body: { jobKey: 'aggregate' }, boundedRetry: true },
    { path: '/api/admin/cron/mail-queue', method: 'POST' as const, body: {}, boundedRetry: true },
    { path: '/api/admin/settings/analytics', method: 'PATCH' as const, body: { timezone: 'UTC', expectedVersion: 1 } },
    { path: '/api/analytics/consent', method: 'POST' as const, body: { analytics: false, consentVersion: 1 } },
    { path: '/api/auth-admin/recovery/enroll', method: 'POST' as const, body: {} },
    { path: '/api/admin/cron/mail-queue', method: 'GET' as const },
  ];
  await withServer((_req, res) => {
    send(res, 503, { error: 'service_unavailable', requestId: UUID, stack: SENTINEL, message: SENTINEL });
  }, async (transport, hits) => {
    for (const call of calls) {
      const before = hits.length;
      const result = fail(await requestApi({
        ...call,
        schema: AccountDTOSchema,
        audience: 'admin',
        transport,
      }));
      assert.equal(hits.length - before, 1, call.path);
      assert.equal(result.attempts, 1, call.path);
      assert.equal(result.retryable, false, call.path);
      assert.equal(result.action, 'stop', call.path);
      absent(result);
    }
  });
});

test('consent and recovery enroll replay once only when the bounded flag is set', async () => {
  let consent = 0;
  let enroll = 0;
  await withServer((req, res) => {
    const enrollPath = req.url === '/api/auth-admin/recovery/enroll';
    const count = enrollPath ? ++enroll : ++consent;
    if (count === 1) send(res, 503, { error: 'service_unavailable', requestId: UUID });
    else send(res, 200, enrollPath ? consentOff : consentOff);
  }, async (transport, hits) => {
    const consentResult = await requestApi({
      path: '/api/analytics/consent',
      method: 'POST',
      body: { analytics: false, consentVersion: 1 },
      schema: ConsentDTOSchema,
      boundedRetry: true,
      transport,
    });
    const enrollResult = await requestApi({
      path: '/api/auth-admin/recovery/enroll',
      method: 'POST',
      body: {},
      schema: ConsentDTOSchema,
      boundedRetry: true,
      transport,
    });
    assert.equal(consentResult.ok, true);
    assert.equal(enrollResult.ok, true);
    if (consentResult.ok) assert.equal(consentResult.attempts, 2);
    if (enrollResult.ok) assert.equal(enrollResult.attempts, 2);
    assert.equal(hits.length, 4);
    assert.equal(hits[0].body, hits[1].body);
    assert.equal(hits[2].body, hits[3].body);
  });
});

test('an ops report replays the same body once', async () => {
  let count = 0;
  const body = { source: 'STORAGE', measuredAt: AT, status: 'FAILED' };
  await withServer((_req, res) => {
    count += 1;
    if (count < 3) send(res, 503, { error: 'service_unavailable', requestId: UUID });
    else send(res, 200, opsReceipt);
  }, async (transport, hits) => {
    const result = fail(await requestApi({
      path: '/api/internal/ops-report',
      method: 'POST',
      body,
      schema: OpsReportReceiptDTOSchema,
      boundedRetry: true,
      transport,
    }));
    assert.equal(hits.length, 2);
    assert.equal(hits[0].body, JSON.stringify(body));
    assert.equal(hits[0].body, hits[1].body);
    assert.equal(result.attempts, 2);
    assert.equal(result.retryable, false);
    assert.equal(result.action, 'stop');
  });
});

test('chat messages keep the same bytes across the 1s, 2s, and 4s schedule', { timeout: 20_000 }, async () => {
  let count = 0;
  const body = { clientMessageId: OTHER, bodyText: 'Can you make this box in blue?' };
  await withServer((_req, res) => {
    count += 1;
    if (count < 4) send(res, 503, { error: 'service_unavailable', requestId: UUID });
    else send(res, 200, received);
  }, async (transport, hits) => {
    const result = await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body,
      schema: MessageReceivedDTOSchema,
      transport,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempts, 4);
    assert.deepEqual(result.data, received);
    assert.equal(hits.length, 4);
    const raw = JSON.stringify(body);
    assert.ok(hits.every((hit) => hit.body === raw && hit.method === 'POST'));
    assert.ok(hits[1].at - hits[0].at >= 900, String(hits[1].at - hits[0].at));
    assert.ok(hits[2].at - hits[1].at >= 1_800, String(hits[2].at - hits[1].at));
    assert.ok(hits[3].at - hits[2].at >= 3_500, String(hits[3].at - hits[2].at));
  });
});

test('chat 429 waits for Retry-After before reusing the original body', async () => {
  let count = 0;
  const body = { clientMessageId: OTHER, bodyText: 'Hello there' };
  await withServer((_req, res) => {
    count += 1;
    if (count === 1) send(res, 429, { error: 'rate_limited', requestId: UUID }, { 'retry-after': '2' });
    else send(res, 200, received);
  }, async (transport, hits) => {
    const result = await requestApi({
      path: '/api/admin/chat/conversations/thread_1/messages',
      method: 'POST',
      body,
      schema: MessageReceivedDTOSchema,
      transport,
    });
    assert.equal(result.ok, true);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].body, hits[1].body);
    assert.ok(hits[1].at - hits[0].at >= 1_800, String(hits[1].at - hits[0].at));
  });
});

test('reauth 429 keeps Retry-After and does not sleep or replay', async () => {
  await withServer((_req, res) => {
    send(res, 429, { error: 'rate_limited', requestId: UUID, message: SENTINEL }, { 'retry-after': '30' });
  }, async (transport, hits) => {
    const started = Date.now();
    const result = fail(await requestApi({
      path: '/api/admin/account/reauth',
      method: 'POST',
      body: { purpose: 'DEVICE_REVOKE', targetId: 'device_1' },
      schema: AccountDTOSchema,
      audience: 'admin',
      boundedRetry: true,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(result.action, 'wait');
    assert.equal(result.retryable, false);
    assert.equal(result.retryAfterMs, 30_000);
    assert.equal(result.attempts, 1);
    absent(result);
  });
});

test('a long Retry-After is returned instead of slept inside the automatic loop', async () => {
  await withServer((_req, res) => {
    send(res, 429, { error: 'rate_limited', requestId: UUID }, { 'retry-after': '31' });
  }, async (transport, hits) => {
    const started = Date.now();
    const result = fail(await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'Hello' },
      schema: MessageReceivedDTOSchema,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(result.action, 'wait');
    assert.equal(result.retryAfterMs, 31_000);
    assert.equal(result.retryable, true);
    assert.equal(result.attempts, 1);
  });
});

test('chat read 404 and analytics 403 stop after one request', async () => {
  let step = 0;
  await withServer((_req, res) => {
    step += 1;
    if (step === 1) send(res, 404, { error: 'not_found', requestId: UUID, stack: SENTINEL });
    else send(res, 403, { error: 'analytics_consent_required', requestId: UUID, message: SENTINEL });
  }, async (transport, hits) => {
    const read = fail(await requestApi({
      path: '/api/chat/conversations/thread_1/read',
      method: 'POST',
      body: { lastReadSeq: 3 },
      schema: MessageReceivedDTOSchema,
      transport,
    }));
    const events = fail(await requestApi({
      path: '/api/analytics/events',
      method: 'POST',
      body: { events: [] },
      schema: AnalyticsReceiptDTOSchema,
      transport,
    }));
    assert.equal(hits.length, 2);
    assert.equal(read.action, 'stop');
    assert.equal(read.retryable, false);
    assert.equal(events.action, 'stop');
    assert.equal(events.code, 'analytics_consent_required');
    assert.match(events.text, /Analytics stays off/);
    absent(read);
    absent(events);
  });
});

test('analytics events replay the same event id once after a 503', async () => {
  let count = 0;
  const body = {
    events: [{
      kind: 'page_view',
      eventId: UUID,
      navigationId: OTHER,
      occurredAt: AT,
      locale: 'en',
      path: '/en',
    }],
  };
  await withServer((_req, res) => {
    count += 1;
    if (count === 1) send(res, 503, { error: 'service_unavailable', requestId: UUID });
    else send(res, 200, receipt);
  }, async (transport, hits) => {
    const result = await requestApi({
      path: '/api/analytics/events',
      method: 'POST',
      body,
      schema: AnalyticsReceiptDTOSchema,
      transport,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.data, receipt);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].body, hits[1].body);
    assert.match(hits[0].body, new RegExp(UUID));
    assert.ok(hits[1].at - hits[0].at >= 900);
  });
});

test('aborting during chat backoff does not send the next attempt', async () => {
  const controller = new AbortController();
  await withServer((_req, res) => {
    send(res, 503, { error: 'service_unavailable', requestId: UUID, stack: SENTINEL });
    setTimeout(() => controller.abort(), 40);
  }, async (transport, hits) => {
    const result = fail(await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'Hello' },
      schema: MessageReceivedDTOSchema,
      signal: controller.signal,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.equal(result.action, 'silent');
    assert.equal(result.text, '');
    absent(result);
  });
});

test('a safe GET that never answers is cancelled at the 15 second deadline', { timeout: 25_000 }, async () => {
  let closes = 0;
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    req.socket.on('close', () => { closes += 1; });
  }, async (transport, hits) => {
    const started = Date.now();
    const result = fail(await requestApi({
      path: '/api/admin/account',
      schema: AccountDTOSchema,
      audience: 'admin',
      transport,
    }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 14_000, `elapsed ${elapsed}`);
    assert.ok(elapsed < 22_000, `elapsed ${elapsed}`);
    assert.equal(hits.length, 1);
    assert.equal(result.action, 'unconfirmed');
    assert.equal(result.attempts, 1);
    assert.equal(result.retryable, true);
    assert.match(result.text, /couldn't be confirmed/);
    assert.equal(result.text.includes('AbortError'), false);
    const deadline = Date.now() + 1_000;
    while (closes < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(closes >= 1);
  });
});

test('aborting one safe GET does not cancel a second in-flight GET', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = new AbortController();
  await withServer((_req, res) => {
    void gate.then(() => {
      try {
        if (!res.writableEnded) send(res, 200, account);
      } catch { /* the aborted socket may already be gone */ }
    });
  }, async (transport, hits) => {
    const left = requestApi({
      path: '/api/admin/account',
      schema: AccountDTOSchema,
      audience: 'admin',
      signal: first.signal,
      transport,
    });
    const right = requestApi({
      path: '/api/admin/account',
      schema: AccountDTOSchema,
      audience: 'admin',
      transport,
    });
    const deadline = Date.now() + 2_000;
    while (hits.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(hits.length, 2);
    first.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [cancelled, kept] = await Promise.all([left, right]);
    const failure = fail(cancelled);
    assert.equal(failure.action, 'silent');
    assert.equal(failure.text, '');
    assert.equal(kept.ok, true);
    if (kept.ok) assert.equal(kept.data.email, account.email);
  });
});

test('parallel chat posts are both sent', async () => {
  await withServer((_req, res) => { send(res, 200, received); }, async (transport, hits) => {
    const body = { clientMessageId: OTHER, bodyText: 'Hello' };
    const [left, right] = await Promise.all([
      requestApi({ path: MESSAGE_PATH, method: 'POST', body, schema: MessageReceivedDTOSchema, transport }),
      requestApi({ path: MESSAGE_PATH, method: 'POST', body, schema: MessageReceivedDTOSchema, transport }),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    assert.equal(hits.length, 2);
  });
});

test('empty, foreign, and dot-segment paths never reach the transport', async () => {
  const paths = [
    '',
    'https://evil.example/api/admin/account',
    '//evil.example/api/admin/account',
    '/api/admin/account/../../etc/passwd',
    '/api\\admin\\account',
    '/api/admin/account/%2e%2e/etc',
    ' /api/admin/account',
    '/api/admin/account#fragment',
  ];
  let calls = 0;
  const transport: ClientTransport = async () => {
    calls += 1;
    throw new Error(SENTINEL);
  };
  for (const path of paths) {
    const result = fail(await requestApi({ path, schema: AccountDTOSchema, transport }));
    assert.equal(result.attempts, 0, path);
    assert.equal(result.action, 'stop');
    absent(result);
  }
  const withBody = fail(await requestApi({
    path: '/api/admin/account',
    method: 'GET',
    body: { secret: SENTINEL },
    schema: AccountDTOSchema,
    transport,
  }));
  const emptyBody = fail(await requestApi({
    path: '/api/admin/account/reauth',
    method: 'POST',
    body: null,
    schema: AccountDTOSchema,
    transport,
  }));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const circular = fail(await requestApi({
    path: '/api/admin/account/reauth',
    method: 'POST',
    body: cycle,
    schema: AccountDTOSchema,
    transport,
  }));
  assert.equal(calls, 0);
  absent(withBody);
  absent(emptyBody);
  absent(circular);
  assert.equal(circular.text.includes('circular'), false);
  assert.equal(circular.text.includes('Converting'), false);
});

test('request bodies over the path cap are refused before fetch', async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    send(res, 200, received);
  }, async (transport, hits) => {
    const accepted = await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'a'.repeat(12_000) },
      schema: MessageReceivedDTOSchema,
      transport,
    });
    const chat = fail(await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'a'.repeat(20_000) },
      schema: MessageReceivedDTOSchema,
      transport,
    }));
    const accountWrite = fail(await requestApi({
      path: '/api/admin/account/reauth',
      method: 'POST',
      body: { note: 'a'.repeat(9_000) },
      schema: AccountDTOSchema,
      transport,
    }));
    assert.equal(accepted.ok, true);
    assert.equal(hits.length, 1);
    assert.equal(calls, 1);
    assert.equal(chat.code, 'too_large');
    assert.equal(chat.attempts, 0);
    assert.equal(chat.retryable, false);
    assert.equal(accountWrite.code, 'too_large');
    assert.equal(accountWrite.attempts, 0);
    assert.match(chat.text, /too large/);
  });
});

test('an oversized response body is not copied into the failure', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(`{"note":"${SENTINEL}"`);
    const pad = 'x'.repeat(64 * 1024);
    let sent = 0;
    try {
      while (sent <= RESPONSE_JSON_MAX_BYTES) {
        res.write(pad);
        sent += pad.length;
      }
      res.end('}');
    } catch { /* client cancel */ }
  }, async (transport) => {
    const result = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, transport }));
    assert.equal(result.code, 'too_large');
    assert.equal(result.retryable, false);
    assert.equal(result.attempts, 1);
    absent(result);
  });
});

test('a thrown transport error and an HTML 500 do not reveal the exception', async () => {
  const thrown: ClientTransport = async () => { throw new Error(SENTINEL); };
  const network = fail(await requestApi({ path: '/api/admin/account', schema: AccountDTOSchema, audience: 'admin', transport: thrown }));
  assert.equal(network.action, 'unconfirmed');
  assert.equal(network.retryable, true);
  assert.equal(network.attempts, 1);
  absent(network);
  await withServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end(`<pre>${SENTINEL}</pre>`);
  }, async (transport, hits) => {
    const html = fail(await requestApi({
      path: '/api/admin/account/reauth',
      method: 'POST',
      body: { purpose: 'DEVICE_REVOKE' },
      schema: AccountDTOSchema,
      boundedRetry: true,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.equal(html.retryable, false);
    assert.equal(html.action, 'stop');
    absent(html);
  });
});

test('Auth.js paths are not fetched or rewritten', async () => {
  let calls = 0;
  const transport: ClientTransport = async () => {
    calls += 1;
    throw new Error(SENTINEL);
  };
  const result = fail(await requestApi({
    path: '/api/auth/callback/credentials',
    method: 'POST',
    body: { error: 'CredentialsSignin', csrfToken: SENTINEL, stack: SENTINEL },
    schema: AccountDTOSchema,
    transport,
  }));
  assert.equal(calls, 0);
  assert.equal(result.envelope, 'auth-unchanged');
  assert.equal(result.attempts, 0);
  assert.equal(result.code, undefined);
  assert.match(result.text, /existing form/);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('CredentialsSignin'), false);
  assert.equal(encoded.includes('bad_credentials'), false);
  assert.equal(encoded.includes(SENTINEL), false);
});

test('a legacy mail failure and a CredentialsSignin body keep their envelopes', async () => {
  let step = 0;
  await withServer((_req, res) => {
    step += 1;
    if (step === 1) send(res, 409, { error: 'mail_failed', message: SENTINEL, stack: SENTINEL });
    else send(res, 401, { error: 'CredentialsSignin', message: SENTINEL, stack: SENTINEL });
  }, async (transport) => {
    const mail = fail(await requestApi({
      path: '/api/admin/account/password',
      method: 'POST',
      body: { newPassword: 'x' },
      schema: AccountDTOSchema,
      transport,
    }));
    const signIn = fail(await requestApi({
      path: '/api/admin/account/reauth',
      method: 'POST',
      body: { purpose: 'DEVICE_REVOKE' },
      schema: AccountDTOSchema,
      transport,
    }));
    assert.equal(mail.envelope, 'legacy');
    assert.equal(mail.code, 'mail_failed');
    assert.equal(mail.text.includes('mail_failed'), false);
    assert.equal(signIn.envelope, 'unavailable');
    assert.equal(signIn.code, undefined);
    assert.equal(JSON.stringify(signIn).includes('CredentialsSignin'), false);
    absent(mail);
    absent(signIn);
  });
});

test('the error adapter is the same function the request path uses', () => {
  const direct = adaptApiError({
    kind: 'http',
    status: 401,
    audience: 'recovery',
    body: { error: 'bad_credentials', requestId: UUID, stack: SENTINEL, fieldErrors: { recoveryCode: 'Try again.' } },
  });
  assert.equal(direct.action, 'inline');
  assert.equal(direct.envelope, 'app');
  assert.deepEqual(direct.fieldErrors, { recoveryCode: 'Try again.' });
  assert.match(direct.text, /not accepted/);
  absent(direct);
});

const encodedAuth = '/api/%61uth/callback/credentials';
const encodedCron = '/api/admin/%63ron/mail-queue';
const encodedChat = '/api/%63hat/conversations/thread_1/%6Dessages';
const encodedAnalytics = '/api/%61nalytics/events';
const decodedChat = '/api/chat/conversations/thread_1/messages';
const decodedAnalytics = '/api/analytics/events';

function dropBody(res: http.ServerResponse, status: number, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.write(`{"message":"${SENTINEL}"`);
  setImmediate(() => { res.destroy(); });
}

test('encoded Auth.js, cron, chat, and analytics paths follow the decoded route', async () => {
  const auto = { delaysMs: MESSAGE_RETRY_DELAYS_MS, explicitReread: true };
  assert.equal(isAuthJsPath(encodedAuth), true);
  assert.equal(isAuthJsPath('/api/auth%2Fcallback/credentials'), true);
  assert.equal(isAuthJsPath('/api/auth-admin/%72ecovery/enroll'), false);
  assert.deepEqual(retryPlanFor('GET', encodedCron), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', '/api/admin/%63ron/operations', true), { delaysMs: [], explicitReread: false });
  assert.deepEqual(retryPlanFor('POST', encodedChat), auto);
  assert.deepEqual(retryPlanFor('POST', encodedAnalytics), auto);
  let authCalls = 0;
  const authTransport: ClientTransport = async () => {
    authCalls += 1;
    throw new Error(SENTINEL);
  };
  const blocked = fail(await requestApi({
    path: encodedAuth,
    method: 'POST',
    body: { csrfToken: SENTINEL, error: 'CredentialsSignin' },
    schema: AccountDTOSchema,
    transport: authTransport,
  }));
  assert.equal(authCalls, 0);
  assert.equal(blocked.envelope, 'auth-unchanged');
  assert.equal(blocked.attempts, 0);
  assert.equal(JSON.stringify(blocked).includes('CredentialsSignin'), false);
  absent(blocked);

  await withServer((req, res) => {
    if (req.url === '/api/admin/cron/mail-queue') send(res, 503, { error: 'service_unavailable', requestId: UUID, stack: SENTINEL });
    else if (req.url === decodedAnalytics) send(res, 200, receipt);
    else send(res, 200, received);
  }, async (transport, hits) => {
    const cron = fail(await requestApi({
      path: encodedCron,
      schema: AccountDTOSchema,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, '/api/admin/cron/mail-queue');
    assert.equal(cron.attempts, 1);
    assert.equal(cron.retryable, false);
    assert.equal(cron.action, 'stop');
    absent(cron);

    const chatBody = { clientMessageId: OTHER, bodyText: 'a'.repeat(12_000) };
    const chat = await requestApi({
      path: encodedChat,
      method: 'POST',
      body: chatBody,
      schema: MessageReceivedDTOSchema,
      transport,
    });
    assert.equal(chat.ok, true);
    assert.equal(hits[1].url, decodedChat);
    assert.equal(hits[1].body, JSON.stringify(chatBody));

    const analyticsBody = { note: 'a'.repeat(20_000) };
    const analytics = await requestApi({
      path: encodedAnalytics,
      method: 'POST',
      body: analyticsBody,
      schema: AnalyticsReceiptDTOSchema,
      transport,
    });
    assert.equal(analytics.ok, true);
    assert.equal(hits[2].url, decodedAnalytics);
    assert.equal(hits.length, 3);
  });
});

test('encoded chat and analytics paths replay the same body once', async () => {
  let chatHits = 0;
  let analyticsHits = 0;
  const chatBody = { clientMessageId: OTHER, bodyText: 'Hello' };
  const analyticsBody = {
    events: [{ kind: 'page_view', eventId: UUID, navigationId: OTHER, occurredAt: AT, locale: 'en', path: '/en' }],
  };
  await withServer((req, res) => {
    if (req.url === decodedChat) {
      chatHits += 1;
      if (chatHits === 1) send(res, 503, { error: 'service_unavailable', requestId: UUID });
      else send(res, 200, received);
      return;
    }
    analyticsHits += 1;
    if (analyticsHits === 1) send(res, 503, { error: 'service_unavailable', requestId: UUID });
    else send(res, 200, receipt);
  }, async (transport, hits) => {
    const chat = await requestApi({
      path: encodedChat,
      method: 'POST',
      body: chatBody,
      schema: MessageReceivedDTOSchema,
      transport,
    });
    const analytics = await requestApi({
      path: encodedAnalytics,
      method: 'POST',
      body: analyticsBody,
      schema: AnalyticsReceiptDTOSchema,
      transport,
    });
    assert.equal(chat.ok, true);
    assert.equal(analytics.ok, true);
    if (chat.ok) assert.equal(chat.attempts, 2);
    if (analytics.ok) assert.equal(analytics.attempts, 2);
    assert.equal(hits.filter((hit) => hit.url === decodedChat).length, 2);
    assert.equal(hits.filter((hit) => hit.url === decodedAnalytics).length, 2);
    assert.equal(hits[0].body, hits[1].body);
    assert.equal(hits[2].body, hits[3].body);
    assert.ok(hits[1].at - hits[0].at >= 900);
    assert.ok(hits[3].at - hits[2].at >= 900);
  });
});

test('a dropped body keeps 401, 403, 404, and 409 from being replayed', async () => {
  const statuses = [401, 403, 404, 409];
  let step = 0;
  await withServer((_req, res) => {
    const status = statuses[step];
    step += 1;
    dropBody(res, status);
  }, async (transport, hits) => {
    for (const status of statuses) {
      const before = hits.length;
      const started = Date.now();
      const result = fail(await requestApi({
        path: MESSAGE_PATH,
        method: 'POST',
        body: { clientMessageId: OTHER, bodyText: 'Hello' },
        schema: MessageReceivedDTOSchema,
        transport,
      }));
      assert.equal(hits.length - before, 1, String(status));
      assert.ok(Date.now() - started < 1_000, String(status));
      assert.equal(result.status, status);
      assert.equal(result.attempts, 1);
      assert.equal(result.retryable, false);
      assert.equal(result.action, 'stop');
      assert.notEqual(result.action, 'unconfirmed');
      absent(result);
    }
  });
});

test('a dropped 429 body keeps Retry-After and does not use the 1/2/4 schedule', async () => {
  await withServer((_req, res) => {
    dropBody(res, 429, { 'retry-after': '31' });
  }, async (transport, hits) => {
    const started = Date.now();
    const result = fail(await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'Hello' },
      schema: MessageReceivedDTOSchema,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(result.status, 429);
    assert.equal(result.action, 'wait');
    assert.equal(result.retryAfterMs, 31_000);
    assert.equal(result.retryable, true);
    assert.equal(result.attempts, 1);
    absent(result);
  });
});

test('a dropped 429 body waits for a short Retry-After before the same body is sent again', async () => {
  let count = 0;
  const body = { clientMessageId: OTHER, bodyText: 'Hello' };
  await withServer((_req, res) => {
    count += 1;
    if (count === 1) dropBody(res, 429, { 'retry-after': '2' });
    else send(res, 200, received);
  }, async (transport, hits) => {
    const result = await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body,
      schema: MessageReceivedDTOSchema,
      transport,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attempts, 2);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].body, hits[1].body);
    assert.ok(hits[1].at - hits[0].at >= 1_800, String(hits[1].at - hits[0].at));
  });
});

test('a 403 whose body never finishes is not replayed when the deadline fires', { timeout: 25_000 }, async () => {
  await withServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.write(`{"message":"${SENTINEL}"`);
  }, async (transport, hits) => {
    const started = Date.now();
    const result = fail(await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'Hello' },
      schema: MessageReceivedDTOSchema,
      transport,
    }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 14_000, `elapsed ${elapsed}`);
    assert.ok(elapsed < 22_000, `elapsed ${elapsed}`);
    assert.equal(hits.length, 1);
    assert.equal(result.status, 403);
    assert.equal(result.action, 'stop');
    assert.equal(result.retryable, false);
    assert.equal(result.attempts, 1);
    absent(result);
  });
});

test('caller abort during a partial 403 body stays silent', async () => {
  const controller = new AbortController();
  await withServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.write(`{"message":"${SENTINEL}"`);
    setTimeout(() => controller.abort(), 40);
  }, async (transport, hits) => {
    const result = fail(await requestApi({
      path: MESSAGE_PATH,
      method: 'POST',
      body: { clientMessageId: OTHER, bodyText: 'Hello' },
      schema: MessageReceivedDTOSchema,
      signal: controller.signal,
      transport,
    }));
    assert.equal(hits.length, 1);
    assert.equal(result.action, 'silent');
    assert.equal(result.text, '');
    assert.equal(result.attempts, 1);
    absent(result);
  });
});
