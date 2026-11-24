import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAnalyticsReload,
  applyInitialAnalyticsLoad,
} from '../src/lib/admin/analytics-settings-state';
import type { AnalyticsSettingsResult } from '../src/lib/client/ops';
import type { AnalyticsSettingsDTO } from '../src/lib/contracts/analytics';

const SERVER_CFG: AnalyticsSettingsDTO = {
  version: 2,
  timezone: 'Europe/Berlin',
  timezoneRevision: 3,
  recomputableFrom: null,
};

function fail(over: Partial<Extract<AnalyticsSettingsResult, { ok: false }>> = {}): AnalyticsSettingsResult {
  return {
    ok: false,
    text: 'The service is temporarily unavailable.',
    action: 'retry',
    envelope: 'app',
    code: 'service_unavailable',
    status: 503,
    retryable: true,
    attempts: 1,
    transient: true,
    ...over,
  };
}

test('M5-T10 首次加载失败后重试成功：同步填充服务端 timezone、清除 loadErr，不误报保留输入', () => {
  const initial = applyInitialAnalyticsLoad(fail());
  assert.equal(initial.saved, null);
  assert.equal(initial.timezone, null);
  assert.ok(initial.loadErr);

  const retried = applyAnalyticsReload(initial.saved, { ok: true, data: SERVER_CFG, attempts: 1 });
  assert.deepEqual(retried.saved, SERVER_CFG);
  assert.equal(retried.timezone, 'Europe/Berlin');
  assert.equal(retried.loadErr, null);
  assert.equal(retried.conflict, false);
  assert.equal(retried.notice, null);
});

test('M5-T10 首次加载失败后重试仍失败：更新 loadErr，不吞错误', () => {
  const retried = applyAnalyticsReload(null, fail({ text: 'Forbidden', code: 'forbidden', status: 403, action: 'stop' }));
  assert.equal(retried.saved, null);
  assert.equal(retried.loadErr, 'Forbidden');
  assert.equal(retried.notice, null);
});

test('M5-T10 首次加载 401（action=login）：退出加载中并呈现明确错误，不永久卡死', () => {
  const expired = applyInitialAnalyticsLoad(fail({
    text: 'Your session has ended. Sign in again to continue.',
    action: 'login',
    code: 'unauthorized',
    status: 401,
  }));
  assert.equal(expired.saved, null);
  assert.equal(expired.loadErr, 'Your session has ended. Sign in again to continue.');
});

test('M5-T10 409 冲突后显式读取最新：不覆写输入框、更新 saved 与版本号、解除冲突', () => {
  const nextCfg: AnalyticsSettingsDTO = { ...SERVER_CFG, version: 3, timezone: 'Asia/Tokyo', timezoneRevision: 4 };
  const reloaded = applyAnalyticsReload(SERVER_CFG, { ok: true, data: nextCfg, attempts: 1 });
  assert.deepEqual(reloaded.saved, nextCfg);
  assert.equal(reloaded.timezone, null, '冲突重读不得覆写用户正在编辑的输入');
  assert.equal(reloaded.conflict, false);
  assert.equal(reloaded.notice?.kind, 'ok');
  assert.match(reloaded.notice?.text ?? '', /version 3/);
});
