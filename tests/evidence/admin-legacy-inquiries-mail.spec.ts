import { isDeepStrictEqual } from 'node:util';
import { lstatSync, readFileSync, realpathSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../../e2e/fixtures';
import { loadRunAuth } from '../../e2e/run-auth';

const BASE = 'http://localhost:3100';
const VIEWPORT = { width: 1440, height: 900 };
const MODE = process.env.SMTP_EVIDENCE_MODE;
const ID = /^[a-z0-9]{20,40}$/;
const SOURCE = process.env.GITHUB_SHA || '';
const stages = new Set(['http-real', 'http-disabled', 'off']);

type Target = {
  version: 1; owner: string; source: string; id: string; ref: string; email: string;
  sentId: string; retryId: string; legacyId: string; legacySubject: string; legacyBody: string;
};
type Stats = { received: number; rcptAttempts: number; rcptFailures: number; authenticated: number; acceptedBytes: number };
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
const root = process.env.SMTP_EVIDENCE_ROOT || '';
const targetPath = process.env.SMTP_EVIDENCE_TARGET_PATH || '';
const syntheticEmail = process.env.SMTP_EVIDENCE_RECIPIENT || '';
let db: PrismaClient;

function provenance() {
  check(process.platform === 'linux' && process.env.CI === 'true' && stages.has(MODE || ''), 'MAIL_EVIDENCE_ISOLATED_MODE_REQUIRED');
  const url = new URL(process.env.DATABASE_URL || '');
  check(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.pathname === '/mail_evidence', 'MAIL_EVIDENCE_DATABASE_REJECTED');
  const parent = realpathSync(process.env.RUNNER_TEMP || '');
  const dir = lstatSync(root);
  check(!dir.isSymbolicLink() && dir.isDirectory() && dir.uid === process.getuid!() && (dir.mode & 0o777) === 0o700, 'MAIL_EVIDENCE_ROOT_REJECTED');
  check(realpathSync(root) === root && path.dirname(root) === parent && path.basename(root).startsWith('nbshiyan-mail-evidence.'), 'MAIL_EVIDENCE_ROOT_PROVENANCE');
  check(targetPath === path.join(root, 'target.json') && /^[a-f0-9]{40}$/.test(SOURCE), 'MAIL_EVIDENCE_SOURCE_REQUIRED');
  const owner = JSON.parse(readFileSync(path.join(root, 'owner.json'), 'utf8')) as { nonce: string; uid: number; rootInode: number };
  check(owner.uid === dir.uid && owner.rootInode === dir.ino && /^[a-f0-9]{32}$/.test(owner.nonce), 'MAIL_EVIDENCE_OWNER_REJECTED');
  check(syntheticEmail === `fixture-${owner.nonce}@customer.example.test`, 'MAIL_EVIDENCE_RECIPIENT_REJECTED');
  return owner;
}

function readTarget(): Target {
  const owner = provenance(), info = lstatSync(targetPath);
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === owner.uid && (info.mode & 0o777) === 0o600 && info.size < 8192, 'MAIL_TARGET_FILE_REJECTED');
  const target = JSON.parse(readFileSync(targetPath, 'utf8')) as Target;
  check(target.version === 1 && target.owner === owner.nonce && target.source === SOURCE && target.email === syntheticEmail && ID.test(target.id) && /^PJ-/.test(target.ref), 'MAIL_TARGET_PROVENANCE_REJECTED');
  check([target.sentId, target.retryId, target.legacyId].every((id) => ID.test(id)), 'MAIL_TARGET_RECORDS_REJECTED');
  return target;
}

async function stats(req: APIRequestContext): Promise<Stats> {
  const response = await req.get('http://127.0.0.1:3998/stats');
  check(response.status() === 200, 'MAIL_SINK_STATS_HTTP');
  const body = await response.json() as Stats;
  check(['received', 'rcptAttempts', 'rcptFailures', 'authenticated', 'acceptedBytes'].every((key) => Number.isSafeInteger(body[key as keyof Stats]) && body[key as keyof Stats] >= 0), 'MAIL_SINK_STATS_SCHEMA');
  return body;
}

async function stored(id: string) {
  check(ID.test(id), 'MAIL_RECORD_ID_REJECTED');
  // Read-only PG observations verify route persistence; no state is inserted or updated here.
  const row = await db.inquiry.findUnique({ where: { id }, select: {
    id: true, ref: true, status: true, assigneeId: true, retainUntil: true, updatedAt: true, anonymizedAt: true,
    notes: { orderBy: { id: 'asc' }, select: { id: true, body: true } }, contact: { select: { email: true, normalizedEmail: true } },
    messages: { orderBy: { id: 'asc' }, select: { id: true, subject: true, bodyHtml: true } },
    mailMessages: { orderBy: { id: 'asc' }, select: { id: true, status: true, retryCount: true, errorCode: true, subject: true, bodyText: true, sentAt: true } },
    _count: { select: { logoUploads: true } },
  } });
  check(row, 'MAIL_TARGET_NOT_FOUND');
  return row;
}

async function validateTarget(target: Target) {
  const row = await stored(target.id);
  check(row.ref === target.ref && row.contact.email === target.email && row.contact.normalizedEmail === target.email && !row.anonymizedAt && row._count.logoUploads === 0, 'MAIL_TARGET_DATABASE_PROVENANCE');
  check(row.messages.some((message) => message.id === target.legacyId && message.subject === target.legacySubject && message.bodyHtml === target.legacyBody), 'MAIL_TARGET_LEGACY_PROVENANCE');
  check([target.sentId, target.retryId].every((id) => row.mailMessages.some((message) => message.id === id && message.status === 'SENT')), 'MAIL_TARGET_SENT_PROVENANCE');
  return row;
}

async function account(req: APIRequestContext) {
  const response = await req.get(`${BASE}/api/admin/account`);
  check(response.status() === 200, 'MAIL_ACCOUNT_HTTP');
  check((await response.json()).role === 'ADMIN', 'MAIL_ACCOUNT_ROLE');
}

async function createInquiry(page: Page): Promise<{ id: string; ref: string }> {
  await page.goto(`${BASE}/en/contact`);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel(/^Name/).fill('Synthetic Mail Evidence');
  await page.getByLabel(/Business email|Email/).fill(syntheticEmail);
  await page.getByLabel(/Company/).fill('Synthetic Mail Evidence Company');
  await page.getByLabel(/Country/).selectOption('DE');
  await page.getByRole('checkbox', { name: /agree|consent|privacy/i }).check();
  const pending = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/inquiries');
  await page.getByRole('button', { name: 'Send request' }).click();
  const response = await pending;
  check(response.status() === 201, 'MAIL_CREATE_INQUIRY_HTTP');
  const body = await response.json();
  check(typeof body.ref === 'string' && /^PJ-/.test(body.ref), 'MAIL_CREATE_INQUIRY_REF');
  await expect(page.getByRole('heading', { name: /Thank you/ })).toBeVisible();
  const listed = await page.request.get(`${BASE}/api/admin/inquiries?q=${encodeURIComponent(body.ref)}`);
  check(listed.status() === 200, 'MAIL_FIXTURE_LIST_HTTP');
  const rows = (await listed.json()).items as Array<{ id: string; ref: string; contact: { email: string } }>;
  const matching = rows.filter((row) => row.ref === body.ref && row.contact.email === syntheticEmail);
  check(matching.length === 1 && ID.test(matching[0].id), 'MAIL_FIXTURE_EXACT_TARGET');
  return { id: matching[0].id, ref: body.ref };
}

async function enterDetail(page: Page, target: Pick<Target, 'id' | 'ref'>) {
  await page.goto(`${BASE}/admin/inquiries?q=${encodeURIComponent(target.ref)}`);
  let row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a[href="/admin/inquiries/${target.id}"]`) });
  if (await row.count() === 0) {
    const expand = page.locator('.inq-list tbody tr.group button[aria-expanded=false]');
    if (await expand.count()) await expand.first().click();
    row = page.locator('.inq-list tbody tr.row').filter({ has: page.locator(`a[href="/admin/inquiries/${target.id}"]`) });
  }
  await expect(row).toHaveCount(1);
  await row.locator('a').click();
  await expect(page.locator('.inq-detail')).toBeVisible();
  await expect(page.locator('.adm-crumb')).toContainText(target.ref);
}

async function frame(page: Page, info: TestInfo, name: string, report: Record<string, unknown>) {
  check(JSON.stringify(page.viewportSize()) === JSON.stringify(VIEWPORT), 'MAIL_FRAME_VIEWPORT');
  const output = info.outputPath(`inquiry-visual-mail-${MODE}-${name}.png`);
  await page.screenshot({ path: output, fullPage: false });
  const bytes = readFileSync(output);
  check(bytes.length > 24 && bytes.toString('ascii', 1, 4) === 'PNG' && bytes.readUInt32BE(16) === 1440 && bytes.readUInt32BE(20) === 900, 'MAIL_FRAME_NATIVE_DIMENSIONS');
  (report.frames as unknown[]).push({ name, width: 1440, height: 900, present: true });
  await info.attach(`mail-${MODE}-${name}`, { path: output, contentType: 'image/png' });
}

async function getThread(req: APIRequestContext, id: string) {
  const response = await req.get(`${BASE}/api/admin/inquiries/${id}/mail?limit=50`);
  check(response.status() === 200, 'MAIL_THREAD_HTTP');
  const body = await response.json() as { items: Array<{ id: string; source: string; status: string; subject: string | null; bodyText: string | null; retryCount: number }> };
  check(Array.isArray(body.items), 'MAIL_THREAD_SCHEMA');
  return body;
}

async function sendFromComposer(page: Page, id: string, subject: string, body: string) {
  const composer = page.getByRole('region', { name: '回复客户', exact: true });
  await expect(composer).toBeVisible();
  await composer.getByLabel('主题', { exact: true }).fill(subject);
  await composer.getByLabel('正文', { exact: true }).fill(body);
  const responsePromise = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/admin/inquiries/${id}/mail`);
  await composer.getByRole('button', { name: '发送', exact: true }).click();
  const response = await responsePromise;
  const sent = response.request().postDataJSON() as { subject: string; body: string };
  check(sent.subject === subject && sent.body === body, 'MAIL_VISIBLE_ACTION_BODY');
  check(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(response.request().headers()['idempotency-key'] || ''), 'MAIL_IDEMPOTENCY_REQUIRED');
  return response;
}

async function enabled(page: Page, expected: boolean) {
  const config = await page.request.get(`${BASE}/api/admin/mail/config`);
  check(config.status() === 200 && (await config.json()).sendingEnabled === expected, 'MAIL_RUNTIME_GATE');
  return config.status();
}

async function real(page: Page, info: TestInfo, report: Record<string, unknown>) {
  const owner = provenance();
  check(!existsSync(targetPath), 'MAIL_TARGET_ALREADY_EXISTS');
  const created = await createInquiry(page);
  const before = await stored(created.id);
  check(before.contact.email === syntheticEmail && before.ref === created.ref && !before.anonymizedAt && before._count.logoUploads === 0 && before.messages.length === 0 && before.mailMessages.length === 0, 'MAIL_NEW_TARGET_PROVENANCE');
  // Frontend notifications/auto receipts may have reached the same local sink. Start business deltas only now.
  const baseline = await stats(page.request);
  report.baselineAfterCreation = { received: baseline.received, rcptFailures: baseline.rcptFailures };
  await enterDetail(page, created);
  await enabled(page, true);
  await frame(page, info, 'before-send', report);
  const subject = 'Synthetic successful reply', content = 'Synthetic successful reply body';
  const response = await sendFromComposer(page, created.id, subject, content);
  check(response.status() === 201, 'MAIL_SUCCESS_HTTP');
  const success = await response.json();
  check(ID.test(success.id) && success.status === 'SENT', 'MAIL_SUCCESS_RESPONSE');
  await expect(page.locator(`article.ml-msg[data-id="${success.id}"] [role=status]`)).toContainText('已发送');
  await expect.poll(async () => (await stats(page.request)).received - baseline.received).toBe(1);
  const persisted = await stored(created.id);
  const saved = persisted.mailMessages.find((message) => message.id === success.id);
  check(saved?.status === 'SENT' && saved.subject === subject && saved.bodyText === content && saved.retryCount === 0 && !!saved.sentAt, 'MAIL_SUCCESS_PERSISTENCE');
  const status = await page.request.get(`${BASE}/api/admin/mail/${success.id}/status`);
  check(status.status() === 200 && (await status.json()).status === 'SENT', 'MAIL_SUCCESS_STATUS_HTTP');
  check((await getThread(page.request, created.id)).items.some((message) => message.id === success.id && message.status === 'SENT'), 'MAIL_SUCCESS_THREAD');
  await page.reload();
  await expect(page.locator(`article.ml-msg[data-id="${success.id}"]`)).toContainText(subject);
  await frame(page, info, 'success-persisted', report);

  const preFailure = await stats(page.request);
  const armed = await page.request.post('http://127.0.0.1:3998/failure/next-rcpt', { headers: { 'x-mail-evidence-control': process.env.SMTP_EVIDENCE_CONTROL || '' } });
  check(armed.status() === 200 && (await armed.json()).armed === true, 'MAIL_RCPT_FAILURE_ARM');
  const failSubject = 'Synthetic manual retry reply', failContent = 'Synthetic manual retry body';
  const failedResponse = await sendFromComposer(page, created.id, failSubject, failContent);
  check(failedResponse.status() === 502, 'MAIL_451_FAILURE_HTTP');
  const failure = await failedResponse.json();
  check(failure.error === 'mail_failed' && failure.reason === 'provider_throttled' && failure.retryable === true && ID.test(failure.id), 'MAIL_451_FAILURE_RESPONSE');
  const failedRow = (await stored(created.id)).mailMessages.find((message) => message.id === failure.id);
  check(failedRow?.status === 'FAILED' && failedRow.errorCode === 'provider_throttled' && failedRow.retryCount === 0 && failedRow.bodyText === failContent, 'MAIL_451_FAILURE_PERSISTENCE');
  const failedCard = page.locator(`article.ml-msg[data-id="${failure.id}"]`);
  await expect(failedCard.getByTestId('send-failed')).toHaveAttribute('data-reason', 'provider_throttled');
  await expect(page.locator('#ml-subj')).toHaveValue(failSubject);
  await expect(page.locator('#ml-body')).toHaveValue(failContent);
  const refused = await stats(page.request);
  check(refused.rcptAttempts - preFailure.rcptAttempts === 1 && refused.rcptFailures - preFailure.rcptFailures === 1 && refused.received === preFailure.received, 'MAIL_451_NO_ACCEPTANCE');
  check((await stored(created.id)).mailMessages.length === 2, 'MAIL_451_ONE_FAILED_RECORD');
  await frame(page, info, '451-manual-retry-available', report);
  const retryPromise = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/admin/mail/${failure.id}/retry`);
  await failedCard.getByRole('button', { name: '重试', exact: true }).click();
  const retryResponse = await retryPromise;
  check(retryResponse.status() === 201 && JSON.stringify(retryResponse.request().postDataJSON()) === '{}', 'MAIL_MANUAL_RETRY_HTTP');
  const retried = await retryResponse.json();
  check(retried.id === failure.id && retried.status === 'SENT' && retried.retryCount === 1, 'MAIL_MANUAL_RETRY_IDENTITY');
  await expect(failedCard.getByRole('status')).toContainText('已发送');
  await expect(page.locator('#ml-body')).toHaveValue('');
  const retriedRow = (await stored(created.id)).mailMessages.find((message) => message.id === failure.id);
  check(retriedRow?.status === 'SENT' && retriedRow.retryCount === 1 && retriedRow.bodyText === failContent && retriedRow.subject === failSubject, 'MAIL_MANUAL_RETRY_PERSISTENCE');
  check((await stored(created.id)).mailMessages.length === 2, 'MAIL_MANUAL_RETRY_NO_DUPLICATE_RECORD');
  await expect.poll(async () => (await stats(page.request)).received - baseline.received).toBe(2);
  const retryStatus = await page.request.get(`${BASE}/api/admin/mail/${failure.id}/status`);
  check(retryStatus.status() === 200 && (await retryStatus.json()).retryCount === 1, 'MAIL_MANUAL_RETRY_STATUS');
  await frame(page, info, 'manual-retry-sent', report);

  // This old API action really creates InquiryMessage; it is not presented as an off-mode visible composer action.
  const legacySubject = 'Synthetic legacy reply', legacyBody = 'Synthetic legacy reply body';
  const legacy = await page.request.post(`${BASE}/api/admin/inquiries/${created.id}/reply`, { headers: { Origin: BASE }, data: { subject: legacySubject, body: legacyBody } });
  check(legacy.status() === 201, 'MAIL_LEGACY_REPLY_HTTP');
  const legacyResponse = await legacy.json();
  check(ID.test(legacyResponse.id), 'MAIL_LEGACY_REPLY_ID');
  const legacyRow = (await stored(created.id)).messages.find((message) => message.id === legacyResponse.id);
  check(legacyRow?.subject === legacySubject && legacyRow.bodyHtml === legacyBody, 'MAIL_LEGACY_PERSISTENCE');
  check((await getThread(page.request, created.id)).items.some((message) => message.id === legacyResponse.id && message.source === 'legacy'), 'MAIL_LEGACY_THREAD_MERGE');
  await page.reload();
  await expect(page.locator(`article.ml-msg[data-id="${legacyResponse.id}"]`)).toContainText('旧记录');
  await expect.poll(async () => (await stats(page.request)).received - baseline.received).toBe(3);
  await frame(page, info, 'real-legacy-merged', report);
  const target: Target = { version: 1, owner: owner.nonce, source: SOURCE, id: created.id, ref: created.ref, email: syntheticEmail, sentId: success.id, retryId: failure.id, legacyId: legacyResponse.id, legacySubject, legacyBody };
  writeFileSync(targetPath, JSON.stringify(target), { mode: 0o600, flag: 'wx' });
  report.actions = { successfulPost201: true, sentPersisted: true, rcpt451BeforeData: true, failed502Persisted: true, visibleManualRetry201: true, sameMailId: true, retryCount: 1, legacyApi201: true, legacySourceMerged: true, acceptedBusinessDelta: 3 };
}

async function disabled(page: Page, info: TestInfo, report: Record<string, unknown>) {
  const target = readTarget();
  await validateTarget(target);
  await enterDetail(page, target);
  await enabled(page, false);
  await expect(page.getByTestId('sending-disabled')).toBeVisible();
  const send = page.getByRole('region', { name: '回复客户', exact: true }).getByRole('button', { name: '发送', exact: true });
  await expect(send).toBeDisabled();
  const before = await stored(target.id), baseline = await stats(page.request);
  const response = await page.request.post(`${BASE}/api/admin/inquiries/${target.id}/mail`, { headers: { Origin: BASE }, data: { subject: 'Synthetic disabled request', body: 'Synthetic disabled body' } });
  check(response.status() === 409 && (await response.json()).error === 'sending_disabled', 'MAIL_DISABLED_POST_409');
  const retry = await page.request.post(`${BASE}/api/admin/mail/${target.retryId}/retry`, { headers: { Origin: BASE }, data: {} });
  check(retry.status() === 409 && (await retry.json()).error === 'sending_disabled', 'MAIL_DISABLED_RETRY_409');
  check(isDeepStrictEqual(await stored(target.id), before), 'MAIL_DISABLED_NO_WRITE');
  check((await stats(page.request)).received === baseline.received, 'MAIL_DISABLED_NO_ACCEPTANCE');
  await page.reload();
  await expect(page.getByTestId('sending-disabled')).toBeVisible();
  await expect(send).toBeDisabled();
  await frame(page, info, 'disabled-no-send', report);
  report.actions = { config200SendingDisabled: true, visibleSendDisabled: true, send409: true, retry409: true, databaseUnchanged: true, acceptedDelta: 0 };
}

async function off(page: Page, info: TestInfo, report: Record<string, unknown>) {
  const target = readTarget();
  await validateTarget(target);
  await enterDetail(page, target);
  const config = await page.request.get(`${BASE}/api/admin/mail/config`);
  check(config.status() === 404 && (await config.json()).error === 'not_found', 'MAIL_OFF_CONFIG_404');
  await expect(page.getByTestId('mail-off')).toBeVisible();
  await expect(page.locator('.ml-compose')).toHaveCount(0);
  await expect(page.getByLabel('回复内容', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  const legacy = page.locator('.adm-msg2.OUTBOUND').filter({ hasText: target.legacySubject });
  await expect(legacy).toHaveCount(1);
  await expect(legacy).toContainText(target.legacyBody);
  const before = await stored(target.id), baseline = await stats(page.request);
  check(before.messages.some((message) => message.id === target.legacyId), 'MAIL_OFF_LEGACY_SOURCE');
  const responses = [
    await page.request.get(`${BASE}/api/admin/inquiries/${target.id}/mail`),
    await page.request.post(`${BASE}/api/admin/inquiries/${target.id}/mail`, { headers: { Origin: BASE }, data: { subject: 'Synthetic off request', body: 'Synthetic off body' } }),
    await page.request.post(`${BASE}/api/admin/inquiries/${target.id}/reply`, { headers: { Origin: BASE }, data: { subject: 'Synthetic off legacy', body: 'Synthetic off legacy body' } }),
    await page.request.get(`${BASE}/api/admin/mail/${target.sentId}/status`),
    await page.request.post(`${BASE}/api/admin/mail/${target.retryId}/retry`, { headers: { Origin: BASE }, data: {} }),
  ];
  for (const response of responses) check(response.status() === 404 && (await response.json()).error === 'not_found', 'MAIL_OFF_ROUTE_404');
  check(isDeepStrictEqual(await stored(target.id), before), 'MAIL_OFF_NO_WRITE');
  check((await stats(page.request)).received === baseline.received, 'MAIL_OFF_NO_ACCEPTANCE');
  await frame(page, info, 'off-legacy-fallback', report);
  report.actions = { config404: true, sendEntriesHidden: true, legacyRecordFallback: true, fiveRoutes404: true, databaseUnchanged: true, acceptedDelta: 0 };
}

check(stages.has(MODE || ''), 'MAIL_EVIDENCE_MODE_REQUIRED');
test(`isolated mail business: ${MODE}`, async ({ page, playwright }, info) => {
  const report: Record<string, unknown> = { source: SOURCE, mode: MODE, viewport: VIEWPORT, pass: false, frames: [], stage: 'initializing', cleanupErrors: [] };
  let primary: unknown;
  try {
    provenance(); db = new PrismaClient();
    const state = await loadRunAuth('content-admin', BASE, playwright.request);
    await page.context().addCookies(state.cookies);
    await page.setViewportSize(VIEWPORT);
    await account(page.request);
    report.stage = MODE;
    if (MODE === 'http-real') await real(page, info, report);
    else if (MODE === 'http-disabled') await disabled(page, info, report);
    else await off(page, info, report);
    report.pass = true;
  } catch (error) {
    const code = error instanceof Error && /^MAIL_[A-Z0-9_]{1,70}$/.test(error.message) ? error.message : 'MAIL_BUSINESS_ASSERTION_FAILED';
    primary = new Error(code); report.error = code; report.pass = false;
  }
  finally {
    const video = page.video();
    try {
      await page.context().close();
      check(video, 'MAIL_VIDEO_REQUIRED');
      const file = await video.path();
      check(existsSync(file) && statSync(file).size > 0, 'MAIL_VIDEO_PERSISTENCE');
      report.video = { present: true, nonEmpty: true, configuredViewport: VIEWPORT, encodedDimensionsMeasured: false };
      await info.attach(`mail-business-${MODE}-video`, { path: file, contentType: 'video/webm' });
    } catch { (report.cleanupErrors as string[]).push('BROWSER_OR_VIDEO_CLEANUP_FAILED'); report.pass = false; }
    try { if (db) await db.$disconnect(); }
    catch { (report.cleanupErrors as string[]).push('DATABASE_DISCONNECT_FAILED'); report.pass = false; }
    const output = info.outputPath(`admin-legacy-inquiries-mail-${MODE}.json`);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
    await info.attach(`mail-business-${MODE}`, { path: output, contentType: 'application/json' });
  }
  if (primary) throw primary;
  check(report.pass === true && (report.cleanupErrors as string[]).length === 0, 'MAIL_BUSINESS_CLEANUP_FAILED');
});
