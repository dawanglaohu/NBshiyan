import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 防回退：/api/rum 必须 await 限流；WebVitals 必须按 analytics 同意门控
test('/api/rum await hitRateLimit', () => {
  const src = readFileSync('src/app/api/rum/route.ts', 'utf8');
  assert.match(src, /await hitRateLimit\(/);
});
test('WebVitals 只在 analytics 同意后上报', () => {
  const src = readFileSync('src/components/analytics/WebVitals.tsx', 'utf8');
  assert.match(src, /hasAnalyticsConsent/);
  assert.match(src, /if \(!ok\.current/);
});
