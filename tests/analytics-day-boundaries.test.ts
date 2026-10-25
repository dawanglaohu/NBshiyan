import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  DayBoundaryError,
  RAW_EVENT_RETENTION_MS,
  recomputableFrom,
  siteDayContaining,
  siteDayUtcBounds,
  siteLocalDate,
  type SiteDayBounds,
} from '../src/lib/analytics/day-boundaries';

const HOUR = 60 * 60 * 1000;

function hours(bounds: SiteDayBounds): number {
  return (Date.parse(bounds.endUtc) - Date.parse(bounds.startUtc)) / HOUR;
}

function assertWindow(localDate: string, timeZone: string, startUtc: string, endUtc: string, durationHours: number) {
  const bounds = siteDayUtcBounds(localDate, timeZone, 'Pacific/Kiritimati');
  const again = siteDayUtcBounds(localDate, timeZone, 'Pacific/Pago_Pago');
  assert.deepEqual(again, bounds);
  assert.equal(bounds.startUtc, startUtc);
  assert.equal(bounds.endUtc, endUtc);
  assert.equal(hours(bounds), durationHours);
  assert.equal(siteLocalDate(new Date(startUtc), timeZone, 'Europe/London'), localDate);
  assert.equal(siteLocalDate(new Date(Date.parse(endUtc) - 1), timeZone, 'Asia/Tokyo'), localDate);
  assert.equal(siteLocalDate(new Date(endUtc), timeZone, 'America/Los_Angeles'), nextDate(localDate));
  const containing = siteDayContaining(new Date(startUtc), timeZone);
  assert.equal(containing.localDate, localDate);
  assert.equal(siteDayContaining(new Date(endUtc), timeZone).localDate, nextDate(localDate));
}

function nextDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + 1));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

test('23 小时春令时和 25 小时秋令时用本地午夜，不加固定 24 小时', () => {
  assertWindow('2026-03-07', 'America/New_York', '2026-03-07T05:00:00.000Z', '2026-03-08T05:00:00.000Z', 24);
  assertWindow('2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23);
  assertWindow('2026-03-09', 'America/New_York', '2026-03-09T04:00:00.000Z', '2026-03-10T04:00:00.000Z', 24);
  assertWindow('2026-10-31', 'America/New_York', '2026-10-31T04:00:00.000Z', '2026-11-01T04:00:00.000Z', 24);
  assertWindow('2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25);
  assertWindow('2026-11-02', 'America/New_York', '2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z', 24);
  assertWindow('2026-10-04', 'Australia/Sydney', '2026-10-03T14:00:00.000Z', '2026-10-04T13:00:00.000Z', 23);
  assertWindow('2026-04-05', 'Australia/Sydney', '2026-04-04T13:00:00.000Z', '2026-04-05T14:00:00.000Z', 25);
});

test('秋令时重复的本地时刻只属于一个 UTC 日，午夜只属于新的一天', () => {
  const day = siteDayUtcBounds('2026-11-01', 'America/New_York');
  const first = new Date('2026-11-01T05:30:00.000Z');
  const second = new Date('2026-11-01T06:30:00.000Z');
  assert.equal(siteLocalDate(first, 'America/New_York'), '2026-11-01');
  assert.equal(siteLocalDate(second, 'America/New_York'), '2026-11-01');
  assert.equal(siteDayContaining(first, 'America/New_York').startUtc, day.startUtc);
  assert.equal(siteDayContaining(second, 'America/New_York').startUtc, day.startUtc);
  assert.equal(siteLocalDate(new Date(day.endUtc), 'America/New_York'), '2026-11-02');
  const dates = ['2026-03-07', '2026-03-08', '2026-03-09', '2026-11-01', '2026-11-02'];
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] === '2026-11-01') continue;
    const previous = siteDayUtcBounds(dates[index - 1], 'America/New_York');
    const current = siteDayUtcBounds(dates[index], 'America/New_York');
    if (nextDate(dates[index - 1]) === dates[index]) assert.equal(previous.endUtc, current.startUtc);
  }
  assert.equal(siteDayUtcBounds('2026-03-08', 'America/New_York').endUtc, siteDayUtcBounds('2026-03-09', 'America/New_York').startUtc);
  assert.equal(siteDayUtcBounds('2026-11-01', 'America/New_York').endUtc, siteDayUtcBounds('2026-11-02', 'America/New_York').startUtc);
});

test('两种浏览器时区不改变站点日，半小时偏移也不按整点截断', () => {
  const instant = new Date('2026-06-15T18:00:00.000Z');
  const site = 'America/New_York';
  const first = siteDayContaining(instant, site, 'Pacific/Kiritimati');
  const second = siteDayContaining(instant, site, 'Pacific/Pago_Pago');
  const bare = siteDayContaining(instant, site);
  assert.deepEqual(first, second);
  assert.deepEqual(first, bare);
  assert.equal(first.localDate, '2026-06-15');
  assert.equal(first.startUtc, '2026-06-15T04:00:00.000Z');
  assert.notEqual(siteLocalDate(instant, 'Pacific/Kiritimati'), siteLocalDate(instant, 'Pacific/Pago_Pago'));
  assertWindow('2026-06-15', 'Asia/Kolkata', '2026-06-14T18:30:00.000Z', '2026-06-15T18:30:00.000Z', 24);
  assertWindow('2026-06-15', 'UTC', '2026-06-15T00:00:00.000Z', '2026-06-16T00:00:00.000Z', 24);
  assertWindow('2026-06-15', 'Asia/Shanghai', '2026-06-14T16:00:00.000Z', '2026-06-15T16:00:00.000Z', 24);
});

test('进程时区变了，站点日的 UTC 边界仍相同', () => {
  const script = [
    "const { siteDayUtcBounds } = require('./src/lib/analytics/day-boundaries.ts');",
    "const bounds = siteDayUtcBounds('2026-03-08', 'America/New_York', process.env.TZ);",
    "process.stdout.write(bounds.startUtc + ' ' + bounds.endUtc);",
  ].join('\n');
  const run = (timeZone: string) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TZ: timeZone },
    });
    const stderr = (child.stderr ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://redacted');
    assert.equal(child.status, 0, stderr);
    return child.stdout;
  };
  assert.equal(run('Pacific/Auckland'), run('America/Los_Angeles'));
  assert.equal(run('Pacific/Auckland'), '2026-03-08T05:00:00.000Z 2026-03-09T04:00:00.000Z');
});

test('空输入、非法时区和无效时刻被拒绝，浏览器时区不能顶上', () => {
  const reject = (run: () => void, reason: DayBoundaryError['reason']) => {
    assert.throws(run, (error: unknown) => error instanceof DayBoundaryError && error.reason === reason);
  };
  reject(() => siteDayUtcBounds('', 'UTC'), 'invalid_date');
  reject(() => siteDayUtcBounds('2026-02-31', 'UTC'), 'invalid_date');
  reject(() => siteDayUtcBounds('2026-6-15', 'UTC'), 'invalid_date');
  reject(() => siteDayUtcBounds('2026-06-15', ''), 'invalid_timezone');
  reject(() => siteDayUtcBounds('2026-06-15', 'Not/AZone'), 'invalid_timezone');
  reject(() => siteDayUtcBounds('2026-06-15', 'UTC+8', 'America/New_York'), 'invalid_timezone');
  reject(() => siteLocalDate(new Date(Number.NaN), 'UTC'), 'invalid_instant');
  reject(() => siteLocalDate(new Date('2026-06-15T00:00:00.000Z'), 'Mars/Base', 'UTC'), 'invalid_timezone');
  reject(() => recomputableFrom(new Date(Number.NaN), 'UTC'), 'invalid_instant');
});

test('可重算起点是不早于 30 天 receivedAt 截止时刻的本地午夜', () => {
  assert.equal(RAW_EVENT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  const now = new Date('2026-06-15T12:00:00.000Z');
  assert.equal(recomputableFrom(now, 'America/New_York'), '2026-05-17T04:00:00.000Z');
  assert.equal(recomputableFrom(now, 'UTC'), '2026-05-17T00:00:00.000Z');
  assert.equal(recomputableFrom(now, 'Asia/Shanghai'), '2026-05-16T16:00:00.000Z');
  const aligned = new Date('2026-06-15T04:00:00.000Z');
  const cutoff = aligned.getTime() - RAW_EVENT_RETENTION_MS;
  assert.equal(recomputableFrom(aligned, 'America/New_York'), '2026-05-16T04:00:00.000Z');
  assert.equal(Date.parse('2026-05-16T04:00:00.000Z'), cutoff);
  assert.ok(Date.parse('2026-05-15T04:00:00.000Z') < cutoff);
});

test('日界线不读取机器本地日历，也不读环境变量', () => {
  const source = readFileSync('src/lib/analytics/day-boundaries.ts', 'utf8');
  assert.doesNotMatch(source, /getHours|getFullYear|getDate\(|getMonth|getDay\(|toLocaleString|process\.env|Date\.now|queryRawUnsafe/);
});
