import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as contracts from '../src/lib/contracts/index';

const uuid = '5fcf5ba2-7d35-4d50-8798-e6f65b1268ef';
const anotherUuid = '7aac1bb7-f310-40e2-bf11-1252744ab7e5';
const at = '2026-10-19T16:20:00.000Z';
const until = '2026-10-19T18:20:00.000Z';
const token = 'A'.repeat(43);
const message = { id: 'cm_example_message', seq: 3, sender: 'VISITOR', bodyText: 'Can you make this box in blue?', createdAt: at };

function rejects(schema: { safeParse: (input: unknown) => { success: boolean } }, values: unknown[]) {
  for (const value of values) {
    assert.equal(schema.safeParse(value).success, false, `Unexpectedly accepted ${JSON.stringify(value)}`);
  }
}

test('E-95: Auth.js rememberDevice uses explicit literal parsing and rejects truthy inputs', () => {
  for (const value of [undefined, false, 'false']) assert.equal(contracts.RememberDeviceSchema.parse(value), false);
  assert.equal(contracts.RememberDeviceSchema.parse('true'), true);
  rejects(contracts.RememberDeviceSchema, [true, 'TRUE', 'False', ' true ', '0', '1', '', 0, 1, null, [], {}]);
  assert.deepEqual(contracts.LoginModeSchema.options, ['password', 'totp']);
  rejects(contracts.LoginModeSchema, ['recovery', 'PASSWORD', '', null]);
});

test('login requests retain the password default and reject recovery credentials or false-like remembering', () => {
  const legacy = { email: 'admin@example.com', password: 'existing password', totp: '001234' };
  assert.deepEqual(contracts.LoginRequestSchema.parse(legacy), { ...legacy, mode: 'password', rememberDevice: false });
  assert.equal(contracts.LoginRequestSchema.parse({ ...legacy, rememberDevice: 'false' }).rememberDevice, false);
  assert.equal(contracts.LoginRequestSchema.parse({ email: legacy.email, mode: 'totp', totp: '001234', rememberDevice: 'true' }).rememberDevice, true);
  rejects(contracts.LoginRequestSchema, [
    { email: legacy.email, totp: '001234' }, { ...legacy, mode: 'recovery' },
    { ...legacy, recoveryCode: 'recovery-secret' }, { ...legacy, totp: 1234 },
    { ...legacy, rememberDevice: true }, { ...legacy, role: 'ADMIN' },
  ]);
});

test('account DTOs expose only documented current-device metadata and explicit Boolean values', () => {
  const currentDevice = {
    id: 'device_1', current: true, remembered: false, createdAt: at, lastActivityAt: at,
    effectiveExpiresAt: until, absoluteExpiresAt: null, revokedAt: null, deviceLabel: null,
  };
  const account = { id: 'user_1', name: null, email: 'admin@example.com', role: 'ADMIN', passwordlessEnabled: false, totpEnabled: true, currentDevice };
  assert.deepEqual(contracts.AccountDTOSchema.parse(account), account);
  rejects(contracts.AccountDTOSchema, [
    { ...account, passwordHash: 'private' }, { ...account, passwordlessEnabled: 'false' },
    { ...account, role: 'OWNER' }, { ...account, currentDevice: { ...currentDevice, tokenHash: token } },
    { ...account, currentDevice: { ...currentDevice, effectiveExpiresAt: 'invalid' } },
  ]);
});

test('account mutations require explicit fresh credentials and preserve named security responses', () => {
  const reauth = { purpose: 'DEVICE_REVOKE', targetId: 'device_1', password: 'existing password', totp: '001234' };
  assert.deepEqual(contracts.ReauthRequestSchema.parse(reauth), reauth);
  rejects(contracts.ReauthRequestSchema, [
    { ...reauth, targetId: undefined }, { ...reauth, password: undefined },
    { ...reauth, purpose: 'ARBITRARY_ACTION' }, { ...reauth, recoveryCode: '0123456789' },
  ]);
  const grant = { token, purpose: 'DEVICE_REVOKE', expiresAt: until };
  assert.deepEqual(contracts.ActionGrantDTOSchema.parse(grant), grant);
  const mode = { passwordlessEnabled: true, actionGrant: token };
  assert.deepEqual(contracts.AccountModeRequestSchema.parse(mode), mode);
  rejects(contracts.AccountModeRequestSchema, [{ ...mode, passwordlessEnabled: 'true' }, { passwordlessEnabled: true }]);
  assert.deepEqual(contracts.AccountModeDTOSchema.parse({ passwordlessEnabled: false, changedAt: at }), { passwordlessEnabled: false, changedAt: at });
  const passwordChange = { newPassword: 'New password 123!', actionGrant: token };
  assert.deepEqual(contracts.PasswordChangeRequestSchema.parse(passwordChange), passwordChange);
  const legacyPasswordChange = { newPassword: passwordChange.newPassword, currentPassword: 'old password', totp: '001234', recoveryCode: '' };
  assert.deepEqual(contracts.PasswordChangeRequestSchema.parse(legacyPasswordChange), legacyPasswordChange);
  rejects(contracts.PasswordChangeRequestSchema, [
    { newPassword: passwordChange.newPassword }, { ...passwordChange, newPassword: 'short' },
    { ...legacyPasswordChange, recoveryCode: '0123456789' }, { ...passwordChange, passwordHash: 'private' },
  ]);
  assert.deepEqual(contracts.PasswordChangeDTOSchema.parse({ ok: true, reauthRequired: true }), { ok: true, reauthRequired: true });
  assert.deepEqual(contracts.TotpResetRequestSchema.parse({ actionGrant: token }), { actionGrant: token });
  assert.deepEqual(contracts.TotpResetDTOSchema.parse({ ok: true, reenrollRequired: true, enrollLink: '/admin/recovery' }), { ok: true, reenrollRequired: true, enrollLink: '/admin/recovery' });
  rejects(contracts.TotpResetRequestSchema, [{ recoveryCode: '0123456789' }, { currentPassword: 'old password' }]);
  assert.deepEqual(contracts.DeviceRevokeRequestSchema.parse({ actionGrant: token }), { actionGrant: token });
  assert.deepEqual(contracts.DeviceRevokeDTOSchema.parse({ id: 'device_1', revokedAt: at }), { id: 'device_1', revokedAt: at });
  assert.deepEqual(contracts.LogoutAllRequestSchema.parse({ actionGrant: token }), { actionGrant: token });
  assert.deepEqual(contracts.SignedOutDTOSchema.parse({ signedOut: true }), { signedOut: true });
  assert.deepEqual(contracts.SessionActivityRequestSchema.parse({}), {});
  rejects(contracts.SessionActivityRequestSchema, [{ rememberDevice: 'true' }, { sid: 'device_1', sv: 999 }]);
  const activity = { effectiveExpiresAt: until, absoluteExpiresAt: null };
  assert.deepEqual(contracts.SessionActivityDTOSchema.parse(activity), activity);
  rejects(contracts.SessionActivityDTOSchema, [{ ...activity, absoluteExpiresAt: at }]);
  const metadata = { sid: 'device_1', sv: 0, ...activity };
  assert.deepEqual(contracts.AuthSessionMetadataSchema.parse(metadata), metadata);
  assert.deepEqual(contracts.AuthSessionMetadataSchema.parse({}), {});
  rejects(contracts.AuthSessionMetadataSchema, [{ ...metadata, tokenHash: token }, { ...metadata, sv: -1 }]);
});

test('legacy reset response preserves issueResponse expiry metadata without dropping fields', () => {
  const response = {
    ok: true, reenrollRequired: true, enrollLink: `https://packjoyu.example/admin/enroll#t=${token}`,
    expiresAt: until, expiresTruncated: true,
  };
  assert.deepEqual(contracts.TotpResetDTOSchema.parse(response), response);
  rejects(contracts.TotpResetDTOSchema, [
    { ...response, expiresAt: 'invalid' }, { ...response, expiresTruncated: 'true' },
    { ...response, enrollTokenHash: 'private' },
  ]);
});

test('legacy initial enrollment keeps its existing fields and distinct response shapes', () => {
  const request = { email: 'admin@example.com', password: 'existing password', token };
  assert.deepEqual(contracts.LegacyEnrollRequestSchema.parse(request), request);
  assert.equal(contracts.LegacyEnrollRequestSchema.parse({ ...request, token: 'x'.repeat(200) }).token, 'x'.repeat(200));
  assert.deepEqual(contracts.LegacyEnrollRequestSchema.parse({ email: ' ADMIN@EXAMPLE.COM ', password: request.password }), { email: request.email, password: request.password });
  assert.deepEqual(contracts.LegacyEnrollConfirmRequestSchema.parse({ ...request, totp: '001234' }), { ...request, totp: '001234' });
  rejects(contracts.LegacyEnrollRequestSchema, [
    { ...request, token: 'x'.repeat(201) }, { ...request, password: '' },
    { ...request, recoveryCode: '0123456789' }, { ...request, pendingPasswordHash: 'injected' },
  ]);
  rejects(contracts.LegacyEnrollConfirmRequestSchema, [{ ...request, totp: 1234 }, { ...request, totp: '12345' }]);
  const enroll = { otpauthUri: 'otpauth://totp/PackJoyU:admin?secret=JBSWY3DPEHPK3PXP&issuer=PackJoyU' };
  assert.deepEqual(contracts.LegacyEnrollDTOSchema.parse(enroll), enroll);
  rejects(contracts.LegacyEnrollDTOSchema, [{ ...enroll, expiresAt: until }]);
  const complete = { recoveryCodes: Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(10, '0')) };
  assert.deepEqual(contracts.LegacyEnrollCompleteDTOSchema.parse(complete), complete);
  rejects(contracts.LegacyEnrollCompleteDTOSchema, [{ ...complete, completed: true }, { recoveryCodes: complete.recoveryCodes.slice(1) }]);
});

test('device pagination validates sort cursors and never accepts device credentials in nested DTOs', () => {
  const device = {
    id: 'device_1', current: true, remembered: false, createdAt: at, lastActivityAt: at,
    effectiveExpiresAt: until, absoluteExpiresAt: null, revokedAt: null, deviceLabel: 'Chrome / Windows',
  };
  const cursor = Buffer.from(JSON.stringify({ createdAt: at, id: 'device_1' })).toString('base64url');
  assert.deepEqual(contracts.DevicePageQuerySchema.parse({}), { limit: 25 });
  assert.deepEqual(contracts.DevicePageQuerySchema.parse({ limit: '50', cursor }), { limit: 50, cursor });
  rejects(contracts.DevicePageQuerySchema, [{ limit: 51 }, { limit: 0 }, { cursor: 'anything' }]);
  const page = { items: [device], nextCursor: null, hasMore: false };
  assert.deepEqual(contracts.DevicePageDTOSchema.parse(page), page);
  rejects(contracts.DevicePageDTOSchema, [{ ...page, items: [{ ...device, sidToken: token }] }, { ...page, items: Array.from({ length: 51 }, () => device) }, { ...page, hasMore: true }]);
  rejects(contracts.DeviceDTOSchema, [{ ...device, remembered: true }, { ...device, lastActivityAt: until, effectiveExpiresAt: at }]);
});

test('restricted recovery schemas reject role escalation, password injection and mismatched credential kinds', () => {
  const authorization = { targetUserId: 'user_2', reason: 'Authenticator lost.', actionGrant: token };
  assert.deepEqual(contracts.RecoveryAuthorizationRequestSchema.parse(authorization), authorization);
  rejects(contracts.RecoveryAuthorizationRequestSchema, [{ ...authorization, reason: ' ' }, { ...authorization, reason: 'x'.repeat(501) }, { ...authorization, reason: 'bad\u0000reason' }]);
  const permit = { token, expiresAt: until };
  assert.deepEqual(contracts.RecoveryPermitDTOSchema.parse(permit), permit);
  const startCode = { email: 'admin@example.com', credentialKind: 'RECOVERY_CODE', credential: '0123456789' };
  const startPermit = { email: 'admin@example.com', credentialKind: 'PERMIT', credential: token };
  assert.deepEqual(contracts.RecoveryStartRequestSchema.parse(startCode), startCode);
  assert.deepEqual(contracts.RecoveryStartRequestSchema.parse(startPermit), startPermit);
  rejects(contracts.RecoveryStartRequestSchema, [
    { ...startCode, credential: token }, { ...startPermit, credential: '0123456789' },
    { ...startCode, credentialKind: 'PASSWORD' }, { ...startCode, role: 'ADMIN' }, { ...startCode, pendingPasswordHash: 'injected' },
  ]);
  const restricted = { restricted: true, expiresAt: until };
  assert.deepEqual(contracts.RecoveryStateDTOSchema.parse(restricted), restricted);
  rejects(contracts.RecoveryStateDTOSchema, [{ ...restricted, restricted: false }, { ...restricted, role: 'ADMIN' }]);
  assert.deepEqual(contracts.RecoveryEnrollRequestSchema.parse({}), {});
  rejects(contracts.RecoveryEnrollRequestSchema, [{ pendingSecret: 'injected' }, { newPassword: 'Injected password 123!' }]);
  const enroll = { otpauthUri: 'otpauth://totp/PackJoyU:admin?secret=JBSWY3DPEHPK3PXP&issuer=PackJoyU', expiresAt: until };
  assert.deepEqual(contracts.RecoveryEnrollDTOSchema.parse(enroll), enroll);
  rejects(contracts.RecoveryEnrollDTOSchema, [{ ...enroll, otpauthUri: 'https://outside.test/secret' }]);
  assert.deepEqual(contracts.RecoveryConfirmRequestSchema.parse({ totp: '001234' }), { totp: '001234' });
  rejects(contracts.RecoveryConfirmRequestSchema, [{ totp: '001234', password: 'injected' }, { totp: '001234', pendingPasswordHash: 'injected' }]);
  const complete = { completed: true, recoveryCodes: Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(10, '0')) };
  assert.deepEqual(contracts.RecoveryCompleteDTOSchema.parse(complete), complete);
  rejects(contracts.RecoveryCompleteDTOSchema, [{ ...complete, completed: false }, { ...complete, recoveryCodes: complete.recoveryCodes.slice(1) }, { ...complete, secret: 'private' }]);
});

test('new errors retain trace ids and controlled field names while legacy guard errors remain consumable', () => {
  const error = { error: 'idempotency_conflict', requestId: uuid, fieldErrors: { clientMessageId: 'This identifier was used for different content.' } };
  assert.deepEqual(contracts.AppErrorDTOSchema.parse(error), error);
  rejects(contracts.AppErrorDTOSchema, [
    { ...error, requestId: 'not-a-uuid' }, { ...error, error: 'raw exception text' },
    { ...error, stack: 'private stack' }, { ...error, fieldErrors: { serverPath: '/secret' } },
    { ...error, fieldErrors: { clientMessageId: 'bad\nmessage' } }, { ...error, fieldErrors: { clientMessageId: 'x'.repeat(201) } }, { ...error, requestId: undefined },
  ]);
  assert.deepEqual(contracts.LegacyGuardErrorSchema.parse({ error: 'unauthorized' }), { error: 'unauthorized' });
  rejects(contracts.LegacyGuardErrorSchema, [{ error: 'Raw exception text' }, { error: 'unauthorized', stack: 'private' }]);
});

test('shared scalar boundaries preserve Unicode, reject control characters and normalize safe paths', () => {
  assert.equal(contracts.BodyTextSchema.parse(`  ${'😀'.repeat(4000)}  `), '😀'.repeat(4000));
  assert.equal(contracts.BodyTextSchema.parse('First line\nSecond line'), 'First line\nSecond line');
  rejects(contracts.BodyTextSchema, ['', '   ', '😀'.repeat(4001), 'hi\u0000there', 'hi\u0001there', 'hi\u200bthere', '<script>alert(1)</script>']);
  assert.equal(contracts.EmailSchema.parse('  sales@example.com  '), 'sales@example.com');
  rejects(contracts.EmailSchema, ['Name <sales@example.com>', 'a@example.com\r\nBcc:b@example.com', 'a@example.com,b@example.com', `${'a'.repeat(250)}@example.com`]);
  assert.equal(contracts.ProductSlugSchema.parse('blue-box-1'), 'blue-box-1');
  assert.equal(contracts.ProductSlugSchema.parse('a'.repeat(120)), 'a'.repeat(120));
  rejects(contracts.ProductSlugSchema, ['Blue-Box', 'a'.repeat(121), 'https://outside.test', '../box']);
  assert.equal(contracts.SitePathSchema.parse('/en/products/blue-box?email=secret@example.com#token'), '/en/products/blue-box');
  assert.equal(contracts.SitePathSchema.parse(`/en/${'a'.repeat(196)}`), `/en/${'a'.repeat(196)}`);
  rejects(contracts.SitePathSchema, ['https://outside.test/en', '//outside.test', '/en\\products', '/en/../admin', '/en/./products', '/en/%2e%2e/admin', '/en/%2Fadmin', `/en/${'a'.repeat(197)}`]);
});

test('shared identifiers, integers, UTC timestamps, dates and timezones reject invalid wire values', () => {
  assert.equal(contracts.UuidSchema.parse(uuid), uuid);
  rejects(contracts.UuidSchema, ['1', 'cm_example', '', null]);
  assert.equal(contracts.NonNegativeIntSchema.parse(2147483647), 2147483647);
  rejects(contracts.NonNegativeIntSchema, [-1, 0.5, 2147483648, '1', Infinity, NaN]);
  assert.equal(contracts.TotpSchema.parse('001234'), '001234');
  rejects(contracts.TotpSchema, [1234, '12345', '1234567', '１２３４５６', ' 123456']);
  assert.equal(contracts.TokenSchema.parse(token), token);
  rejects(contracts.TokenSchema, ['x'.repeat(129), 'a/b+c=', '', null]);
  assert.equal(contracts.UtcDateTimeSchema.parse(at), at);
  rejects(contracts.UtcDateTimeSchema, ['2026-02-30T16:20:00.000Z', '2026-10-19T16:20:00+02:00', '2026-10-19', new Date(at)]);
  assert.equal(contracts.LocalDateSchema.parse('2024-02-29'), '2024-02-29');
  rejects(contracts.LocalDateSchema, ['2025-02-29', '2026-04-31', '2026-1-01', '2026-10-19T00:00:00Z']);
  assert.equal(contracts.TimezoneSchema.parse('America/New_York'), 'America/New_York');
  rejects(contracts.TimezoneSchema, ['Not/A_Timezone', 'UTC+8', '']);
});

test('chat request and nested response schemas keep only documented fields', () => {
  const create = {
    clientConversationId: uuid, clientMessageId: anotherUuid, locale: 'en',
    bodyText: 'Please send pricing.', email: 'sales@example.com', productSlug: 'blue-box', sourcePath: '/en/products/blue-box',
  };
  assert.deepEqual(contracts.ConversationCreateRequestSchema.parse(create), create);
  rejects(contracts.ConversationCreateRequestSchema, [
    { ...create, locale: 'de' }, { ...create, clientMessageId: '7' }, { ...create, sender: 'OPERATOR' },
    { ...create, visitorSessionId: 'someone-else' }, { ...create, bodyText: 'x'.repeat(4001) },
  ]);
  const received = { conversationId: 'cv_example', message, receivedAt: at, duplicate: false };
  assert.deepEqual(contracts.ConversationReceivedDTOSchema.parse(received), received);
  rejects(contracts.ConversationReceivedDTOSchema, [
    { ...received, cookie: token }, { ...received, message: { ...message, authorId: 'user_1' } },
    { ...received, message: { ...message, seq: 0 } }, { ...received, duplicate: 'false' },
  ]);
  assert.deepEqual(contracts.ChatSessionRequestSchema.parse({ locale: 'ru' }), { locale: 'ru' });
  assert.deepEqual(contracts.ChatSessionDTOSchema.parse({ available: false, expiresAt: until }), { available: false, expiresAt: until });
  assert.deepEqual(contracts.ChatReadRequestSchema.parse({ lastReadSeq: 0 }), { lastReadSeq: 0 });
  rejects(contracts.ChatReadRequestSchema, [{ lastReadSeq: -1 }, { lastReadSeq: '0' }, { lastReadSeq: 2147483648 }]);
  assert.deepEqual(contracts.ChatStatusRequestSchema.parse({ status: 'CLOSED', expectedVersion: 0 }), { status: 'CLOSED', expectedVersion: 0 });
  rejects(contracts.ChatStatusRequestSchema, [{ status: 'OPEN', expectedVersion: 0 }, { status: 'CLOSED' }, { status: 'CLOSED', expectedVersion: '1' }]);
});

test('chat pagination validates wire queries, nested privacy and monotonic sequence boundaries', () => {
  assert.deepEqual(contracts.ChatMessagesQuerySchema.parse({}), { afterSeq: 0, limit: 50 });
  assert.deepEqual(contracts.ChatMessagesQuerySchema.parse({ afterSeq: '3', limit: '100' }), { afterSeq: 3, limit: 100 });
  rejects(contracts.ChatMessagesQuerySchema, [{ afterSeq: '-1' }, { afterSeq: '1.5' }, { limit: 101 }, { limit: 0 }, { limit: '1e2' }]);
  assert.deepEqual(contracts.ChatSummaryQuerySchema.parse({ unreadOnly: 'false' }), { limit: 25, unreadOnly: false });
  const cursor = Buffer.from(JSON.stringify({ updatedAt: at, id: 'cv_example' })).toString('base64url');
  assert.deepEqual(contracts.ChatSummaryQuerySchema.parse({ cursor }), { cursor, limit: 25, unreadOnly: false });
  const injectedCursor = Buffer.from(JSON.stringify({ updatedAt: at, id: 'cv_example', query: 'SELECT * FROM ChatConversation' })).toString('base64url');
  rejects(contracts.ChatSummaryQuerySchema, [{ unreadOnly: 'anything' }, { cursor: 'SELECT * FROM ChatConversation' }, { cursor: injectedCursor }, { cookie: token }]);
  const conversation = {
    id: 'cv_example', locale: 'en', productSlug: null, sourcePath: null, status: 'OPEN', version: 0,
    createdAt: at, updatedAt: at, lastActivityAt: at, retainUntil: '2027-01-17T16:20:00.000Z', anonymizedAt: null,
  };
  const sync = { conversation, messages: [message], lastSeq: 3, nextAfterSeq: 3, hasMore: false, read: { lastReadSeq: 0 } };
  assert.deepEqual(contracts.ChatSyncDTOSchema.parse(sync), sync);
  rejects(contracts.ChatSyncDTOSchema, [
    { ...sync, conversation: { ...conversation, email: 'private@example.com' } },
    { ...sync, read: { lastReadSeq: 4 } }, { ...sync, nextAfterSeq: 4 }, { ...sync, nextAfterSeq: 2 },
    { ...sync, messages: [message, { ...message, seq: 2 }] },
    { ...sync, messages: Array.from({ length: 101 }, (_, index) => ({ ...message, seq: index + 1 })), lastSeq: 101, nextAfterSeq: 101 },
    { ...sync, conversation: { ...conversation, retainUntil: at } },
    { ...sync, hasMore: true },
  ]);
  const adminConversation = { ...conversation, email: 'sales@example.com' };
  const adminSync = { ...sync, conversation: adminConversation };
  assert.deepEqual(contracts.AdminChatSyncDTOSchema.parse(adminSync), adminSync);
  const page = { items: [{ ...adminConversation, lastSeq: 3, lastReadSeq: 0 }], nextCursor: null, hasMore: false, unreadTotal: 3 };
  assert.deepEqual(contracts.ChatSummaryPageDTOSchema.parse(page), page);
  rejects(contracts.ChatSummaryPageDTOSchema, [{ ...page, hasMore: true }, { ...page, items: [{ ...page.items[0], visitorSessionId: token }] }]);
});

test('analytics event variants reject private data and fields belonging to another event kind', () => {
  const base = { eventId: uuid, navigationId: anotherUuid, occurredAt: at, locale: 'en' };
  const page = { ...base, kind: 'page_view', path: '/en' };
  assert.deepEqual(contracts.AnalyticsEventDTOSchema.parse(page), page);
  const model = { ...base, kind: 'model_load_failure', viewId: uuid, productSlug: 'blue-box', durationMs: 600000, failureReason: 'TIMEOUT' };
  assert.deepEqual(contracts.AnalyticsEventDTOSchema.parse(model), model);
  const allKinds = [
    { ...base, kind: 'product_view', productSlug: 'blue-box' },
    { ...base, kind: 'model_view_start', viewId: uuid, productSlug: 'blue-box' },
    { ...base, kind: 'model_load_success', viewId: uuid, productSlug: 'blue-box', durationMs: 0 },
    { ...base, kind: 'chat_start' },
  ];
  for (const event of allKinds) assert.deepEqual(contracts.AnalyticsEventDTOSchema.parse(event), event);
  rejects(contracts.AnalyticsEventDTOSchema, [
    { ...page, email: 'private@example.com' }, { ...page, browserId: uuid }, { ...page, durationMs: 0 },
    { ...page, kind: 'arbitrary_event' }, { ...model, durationMs: 600001 }, { ...model, failureReason: 'raw stack trace' },
    { ...model, kind: 'model_load_success' }, { ...model, productSlug: undefined },
    { ...base, kind: 'chat_start', conversationId: 'cv_example' },
  ]);
  assert.deepEqual(contracts.AnalyticsEventsRequestSchema.parse({ events: [page] }), { events: [page] });
  rejects(contracts.AnalyticsEventsRequestSchema, [{ events: [] }, { events: Array.from({ length: 21 }, () => page) }, { events: [page], browserHash: token }]);
  assert.deepEqual(contracts.ConsentRequestSchema.parse({ analytics: false, consentVersion: 1 }), { analytics: false, consentVersion: 1 });
  rejects(contracts.ConsentRequestSchema, [{ analytics: 'false', consentVersion: 1 }, { analytics: false, consentVersion: 0 }, { analytics: false, consentVersion: 1, browserId: uuid }]);
  assert.deepEqual(contracts.AnalyticsReceiptDTOSchema.parse({ acceptedIds: [uuid], duplicateIds: [anotherUuid], receivedAt: at }), { acceptedIds: [uuid], duplicateIds: [anotherUuid], receivedAt: at });
});

test('analytics settings and consent responses retain explicit Boolean and time revision fields', () => {
  const settings = { version: 0, timezone: 'America/New_York', timezoneRevision: 1, recomputableFrom: null };
  assert.deepEqual(contracts.AnalyticsSettingsDTOSchema.parse(settings), settings);
  assert.deepEqual(contracts.AnalyticsSettingsUpdateRequestSchema.parse({ timezone: 'UTC', expectedVersion: 0 }), { timezone: 'UTC', expectedVersion: 0 });
  rejects(contracts.AnalyticsSettingsUpdateRequestSchema, [{ timezone: 'Invalid/Timezone', expectedVersion: 0 }, { timezone: 'UTC' }, { timezone: 'UTC', expectedVersion: -1 }]);
  rejects(contracts.AnalyticsSettingsDTOSchema, [{ ...settings, timezoneRevision: 0 }, { ...settings, updatedBy: 'private-user' }]);
  assert.deepEqual(contracts.ConsentDTOSchema.parse({ analytics: false, expiresAt: null }), { analytics: false, expiresAt: null });
  assert.deepEqual(contracts.ConsentDTOSchema.parse({ analytics: true, expiresAt: until }), { analytics: true, expiresAt: until });
  rejects(contracts.ConsentDTOSchema, [{ analytics: true, expiresAt: null }, { analytics: false, expiresAt: until }, { analytics: true, expiresAt: until, browserId: uuid }]);
});

test('stats distinguish verified zero from absent or failed data and enforce calendar ranges', () => {
  const source = {
    source: 'page_views', state: 'zero', value: 0, timezone: 'UTC', timezoneRevision: 1,
    dataThrough: at, queriedAt: at, lastSucceededAt: at, coverage: 'full',
  };
  assert.deepEqual(contracts.StatsDTOSchema.parse({ sources: [source] }), { sources: [source] });
  const states = [
    { ...source, state: 'ok', value: 1 }, { ...source, state: 'stale', value: 1 },
    ...['no_data', 'not_connected', 'query_failed'].map((state) => ({ ...source, state, value: null, dataThrough: null, lastSucceededAt: null, coverage: 'unavailable' })),
  ];
  for (const value of states) assert.deepEqual(contracts.StatsSourceDTOSchema.parse(value), value);
  rejects(contracts.StatsSourceDTOSchema, [
    { ...source, state: 'no_data' }, { ...source, state: 'zero', value: null },
    { ...source, value: -1 }, { ...source, lastSucceededAt: null }, { ...source, browserHash: token },
    { ...source, state: 'not_connected', value: 0 },
  ]);
  rejects(contracts.StatsDTOSchema, [{ sources: [source, source] }, { sources: [source], ok: true }]);
  const query = { from: '2024-01-01', to: '2025-02-03', timezoneRevision: '1' };
  assert.deepEqual(contracts.StatsQuerySchema.parse(query), { ...query, timezoneRevision: 1 });
  rejects(contracts.StatsQuerySchema, [
    { from: '2024-01-01', to: '2025-02-04' }, { from: '2026-10-20', to: '2026-10-19' },
    { from: '2026-02-30' }, { timezoneRevision: 0 }, { sources: ['page_views', 'page_views'] },
    { sources: ['arbitrary_database_table'] },
  ]);
});

test('fixed operation jobs and reports reject arbitrary commands, unsafe values and nested extras', () => {
  assert.deepEqual(contracts.OperationsRequestSchema.parse({ jobKey: 'analytics-retention' }), { jobKey: 'analytics-retention', dryRun: true });
  assert.deepEqual(contracts.OperationsRequestSchema.parse({ jobKey: 'chat-retention', dryRun: false }), { jobKey: 'chat-retention', dryRun: false });
  for (const jobKey of ['analytics-aggregate', 'chat-notifications', 'mail-queue', 'ops-sample']) {
    assert.deepEqual(contracts.OperationsRequestSchema.parse({ jobKey }), { jobKey });
  }
  rejects(contracts.OperationsRequestSchema, [
    { jobKey: 'run-shell' }, { jobKey: 'analytics-retention', dryRun: 'false' },
    { jobKey: 'analytics-aggregate', dryRun: true }, { jobKey: 'ops-sample', script: 'anything' },
  ]);
  const result = { jobKey: 'analytics-retention', status: 'SUCCEEDED', counts: { deletedCount: 0 }, finishedAt: at };
  assert.deepEqual(contracts.JobResultDTOSchema.parse(result), result);
  rejects(contracts.JobResultDTOSchema, [{ ...result, counts: { deletedCount: -1 } }, { ...result, counts: { deletedCount: 0, filesystemPath: '/secret' } }]);
  const report = { source: 'STORAGE', measuredAt: at, status: 'OK', values: { bytesUsed: 0, bytesFree: 1024 } };
  assert.deepEqual(contracts.OpsReportRequestSchema.parse(report), report);
  const backup = { source: 'BACKUP', measuredAt: until, status: 'OK', values: { backupAgeSeconds: 7200, verified: true, backupCompletedAt: at } };
  assert.deepEqual(contracts.OpsReportRequestSchema.parse(backup), backup);
  for (const status of ['FAILED', 'NOT_CONNECTED']) {
    const unavailable = { source: 'STORAGE', measuredAt: at, status, safeErrorCode: 'service_unavailable' };
    assert.deepEqual(contracts.OpsReportRequestSchema.parse(unavailable), unavailable);
  }
  rejects(contracts.OpsReportRequestSchema, [
    { ...report, values: { bytesUsed: 0, bytesFree: 1024, path: '/secret' } },
    { ...report, values: { bytesUsed: -1, bytesFree: 1024 } }, { ...report, values: null },
    { ...report, values: { backupAgeSeconds: 1, verified: true, backupCompletedAt: at } },
    { source: 'BACKUP', measuredAt: at, status: 'OK', values: { backupAgeSeconds: 0, verified: true, backupCompletedAt: until } },
  ]);
  assert.deepEqual(contracts.OpsReportReceiptDTOSchema.parse({ accepted: false, measuredAt: at }), { accepted: false, measuredAt: at });
});

test('runtime-supported IANA aliases remain valid timezones', () => {
  for (const timezone of ['CET', 'GMT', 'EST5EDT']) assert.equal(contracts.TimezoneSchema.parse(timezone), timezone);
});

test('retention dry-run reports candidate and actual deletion counts separately', () => {
  const job = { jobKey: 'analytics-retention', status: 'SUCCEEDED', counts: { candidateCount: 12, deletedCount: 0 }, finishedAt: at };
  assert.deepEqual(contracts.JobResultDTOSchema.parse(job), job);
  rejects(contracts.JobResultDTOSchema, [{ ...job, counts: { candidateCount: -1 } }, { ...job, counts: { candidateCount: 2147483648 } }]);
});

test('measured model averages carry samples while count sources reject fractions', () => {
  const mean = {
    source: 'mean_load_duration_ms', state: 'ok', value: 125.5, loadDurationSamples: 2,
    timezone: 'UTC', timezoneRevision: 1, dataThrough: at, queriedAt: until, lastSucceededAt: at, coverage: 'full',
  };
  assert.deepEqual(contracts.StatsSourceDTOSchema.parse(mean), mean);
  const { loadDurationSamples: omitted, ...withoutSamples } = mean;
  assert.equal(omitted, 2);
  assert.deepEqual(contracts.StatsSourceDTOSchema.parse({ ...mean, state: 'no_data', value: null, loadDurationSamples: 0 }),
    { ...mean, state: 'no_data', value: null, loadDurationSamples: 0 });
  rejects(contracts.StatsSourceDTOSchema, [
    withoutSamples, { ...mean, loadDurationSamples: 0 }, { ...mean, loadDurationSamples: -1 },
    { ...mean, loadDurationSamples: 1.5 }, { ...mean, value: 600001 },
    { ...mean, source: 'page_views' }, { ...withoutSamples, source: 'page_views', value: 0.5 },
    { ...mean, state: 'no_data', value: null, loadDurationSamples: 1 },
  ]);
});

test('the public barrel compiles for an independent strict TypeScript consumer without DOM or app aliases', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const consumerFile = resolve(root, 'tests/contracts-foundation.consumer.ts');
  const consumerSource = `
    import { LoginModeSchema, ChatMessageDTOSchema, type LoginMode, type ChatMessageDTO, type AccountDTO, type RecoveryStateDTO, type AnalyticsEventDTO, type StatsDTO, type AppErrorDTO } from '../src/lib/contracts/index';
    const loginMode: LoginMode = 'totp';
    const message: ChatMessageDTO = { id: 'cm_example', seq: 1, sender: 'VISITOR', bodyText: 'Hello', createdAt: '${at}' };
    LoginModeSchema.parse(loginMode);
    ChatMessageDTOSchema.parse(message);
    const domainTypes: [AccountDTO['role'], RecoveryStateDTO['restricted'], AnalyticsEventDTO['kind'], StatsDTO['sources'][number]['state'], AppErrorDTO['error']] = ['ADMIN', true, 'page_view', 'zero', 'invalid'];
    // @ts-expect-error Recovery credentials do not define a daily login mode.
    const invalidMode: LoginMode = 'recovery';
    // @ts-expect-error DTO fields retain the schema's precise wire types.
    const invalidBody: ChatMessageDTO['bodyText'] = 123;
    // @ts-expect-error Private server author identifiers are absent from the shared DTO.
    const invalidPrivateField: ChatMessageDTO['authorId'] = 'user_1';
    // @ts-expect-error Restricted recovery DTOs never provide a backend role.
    const invalidRecoveryRole: RecoveryStateDTO['role'] = 'ADMIN';
  `;
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ['lib.es2022.d.ts'], types: [], skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(fileName) === consumerFile
      ? ts.createSourceFile(fileName, consumerSource, languageVersion, true)
      : readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([consumerFile], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const sourcePaths = program.getSourceFiles().map((source) => source.fileName.replaceAll('\\', '/'));
  assert.equal(sourcePaths.some((path) => /\/(?:server|@prisma|next-auth)\//i.test(path)), false, sourcePaths.join('\n'));
  assert.equal(sourcePaths.some((path) => /\/lib\.dom(?:\.iterable)?\.d\.ts$/i.test(path)), false);
});
