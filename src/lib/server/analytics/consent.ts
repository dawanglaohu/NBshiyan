import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { analyticsConsentSecret } from '../config';
import { UuidSchema } from '../../contracts/common';
import type { ConsentDTO } from '../../contracts/analytics';
import { CONSENT_MAX_AGE_MS, CONSENT_VERSION } from '../../consent';
import { isProdEnvFrom } from '../../site';

/** HttpOnly 分析同意 cookie。验签失败、缺失和到期都不能当作已同意。本模块不读 process.env，也不写 HTTP 响应。 */
export const ANALYTICS_COOKIE_NAME = 'pj_analytics';
export const ANALYTICS_COOKIE_PATH = '/api/analytics';
export const ANALYTICS_COOKIE_MAX_LENGTH = 256;
export const CONSENT_BODY_MAX_BYTES = 32 * 1024;
export const CONSENT_IP_RATE_LIMIT = 20;
export const CONSENT_COOKIE_RATE_LIMIT = 10;
export const CONSENT_RATE_WINDOW_MS = 10 * 60 * 1000;
export const CONSENT_RETRY_AFTER_SECONDS = 600;

const COOKIE_MAC_LABEL = 'analytics-consent-cookie-v1';
const BROWSER_HASH_LABEL = 'analytics-browser-hash-v1';
const FUTURE_SKEW_MS = 60_000;
const MAC_TEXT = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_INT = /^(0|[1-9][0-9]*)$/;
const CLEARED_EXPIRES = 'Thu, 01 Jan 1970 00:00:00 GMT';

export type AnalyticsCookieRead =
  | { kind: 'absent' }
  | { kind: 'one'; value: string }
  | { kind: 'ambiguous' };

export type VerifiedAnalyticsConsent = {
  browserId: string;
  browserHash: string;
  consentVersion: number;
  grantedAt: string;
  expiresAt: string;
};

export type ConsentApplyResult =
  | { ok: true; body: ConsentDTO; setCookie: string }
  | { ok: false; code: 'invalid' | 'service_unavailable' };

type ConsentKeys = { mac: Buffer; browser: Buffer };

export type AnalyticsConsentService = {
  verifyValue(value: string): VerifiedAnalyticsConsent | null;
  verifyHeader(header: string | null): VerifiedAnalyticsConsent | null;
  apply(input: {
    analytics: boolean;
    consentVersion: number;
    cookieValue?: string;
    secure: boolean;
  }): ConsentApplyResult;
};

/**
 * 生产始终 Secure。非生产只对 localhost、127.0.0.1、::1 省略 Secure，预览域名仍带 Secure。
 * 看请求 URL 的主机，不看调用方声称的 Origin。
 */
export function analyticsCookieSecure(requestUrl: string, env: Record<string, string | undefined>): boolean {
  if (isProdEnvFrom(env)) return true;
  try {
    const host = new URL(requestUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return true;
  }
}

/** 同名 cookie 出现多次则无法判断该信哪一张，调用方必须当成没有有效同意。空值视为没有这张 cookie。 */
export function readAnalyticsCookie(header: string | null): AnalyticsCookieRead {
  if (!header) return { kind: 'absent' };
  const matches: string[] = [];
  for (const part of header.split(';')) {
    const segment = part.trim();
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    if (segment.slice(0, eq).trim() !== ANALYTICS_COOKIE_NAME) continue;
    matches.push(segment.slice(eq + 1));
  }
  if (matches.length === 0 || matches.every((value) => value.length === 0)) return { kind: 'absent' };
  if (matches.length !== 1) return { kind: 'ambiguous' };
  return { kind: 'one', value: matches[0] };
}

export function createAnalyticsConsentService(deps: {
  secret?: Buffer | null;
  env?: Record<string, string | undefined>;
  clock?: () => Date;
  randomId?: () => string;
} = {}): AnalyticsConsentService {
  const clock = deps.clock ?? (() => new Date());
  const randomId = deps.randomId ?? randomUUID;
  const secret = deps.secret !== undefined ? deps.secret : (deps.env ? analyticsConsentSecret(deps.env) : null);
  const keys = consentKeys(secret);

  function nowMs(): number {
    const ms = clock().getTime();
    if (!Number.isFinite(ms)) throw new Error('consent clock');
    return ms;
  }

  function verifyValue(value: string): VerifiedAnalyticsConsent | null {
    return verifyConsentValue(value, keys, nowMs());
  }

  return {
    verifyValue,
    verifyHeader(header) {
      const read = readAnalyticsCookie(header);
      if (read.kind !== 'one') return null;
      return verifyValue(read.value);
    },
    apply(input) {
      if (input.consentVersion !== CONSENT_VERSION) return { ok: false, code: 'invalid' };
      if (input.analytics === false) {
        // 没有吊销名单。false 只让浏览器丢掉 cookie；调用方若把旧值再送回来，到期前验签仍然通过。
        return {
          ok: true,
          body: { analytics: false, expiresAt: null },
          setCookie: clearCookie(input.secure),
        };
      }
      if (input.analytics !== true) return { ok: false, code: 'invalid' };
      if (!keys) return { ok: false, code: 'service_unavailable' };
      const now = nowMs();
      const verified = input.cookieValue ? verifyConsentValue(input.cookieValue, keys, now) : null;
      if (verified) {
        const grantedAtMs = Date.parse(verified.grantedAt);
        const expiresAtMs = Date.parse(verified.expiresAt);
        const token = signConsent(keys, verified.browserId, verified.consentVersion, grantedAtMs, expiresAtMs);
        return {
          ok: true,
          body: { analytics: true, expiresAt: verified.expiresAt },
          setCookie: grantCookie(token, expiresAtMs, now, input.secure),
        };
      }
      const browserId = randomId();
      if (typeof browserId !== 'string' || !UuidSchema.safeParse(browserId).success) throw new Error('consent id');
      const grantedAtMs = now;
      const expiresAtMs = grantedAtMs + CONSENT_MAX_AGE_MS;
      const token = signConsent(keys, browserId, CONSENT_VERSION, grantedAtMs, expiresAtMs);
      return {
        ok: true,
        body: { analytics: true, expiresAt: new Date(expiresAtMs).toISOString() },
        setCookie: grantCookie(token, expiresAtMs, now, input.secure),
      };
    },
  };
}

function consentKeys(secret: Buffer | null): ConsentKeys | null {
  if (!Buffer.isBuffer(secret) || secret.length < 32) return null;
  return {
    mac: createHmac('sha256', secret).update(COOKIE_MAC_LABEL).digest(),
    browser: createHmac('sha256', secret).update(BROWSER_HASH_LABEL).digest(),
  };
}

function canonicalInt(raw: string): number | null {
  if (!CANONICAL_INT.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function verifyConsentValue(value: string, keys: ConsentKeys | null, now: number): VerifiedAnalyticsConsent | null {
  if (!keys || value.length < 1 || value.length > ANALYTICS_COOKIE_MAX_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 6) return null;
  const [tag, browserId, versionRaw, grantedRaw, expiresRaw, mac] = parts;
  if (tag !== 'v1' || !browserId || !UuidSchema.safeParse(browserId).success) return null;
  const consentVersion = canonicalInt(versionRaw);
  const grantedAtMs = canonicalInt(grantedRaw);
  const expiresAtMs = canonicalInt(expiresRaw);
  if (consentVersion === null || grantedAtMs === null || expiresAtMs === null) return null;
  if (consentVersion !== CONSENT_VERSION) return null;
  if (grantedAtMs > Number.MAX_SAFE_INTEGER - CONSENT_MAX_AGE_MS) return null;
  if (expiresAtMs !== grantedAtMs + CONSENT_MAX_AGE_MS) return null;
  if (!MAC_TEXT.test(mac)) return null;
  const prefix = `v1.${browserId}.${versionRaw}.${grantedRaw}.${expiresRaw}`;
  const expected = createHmac('sha256', keys.mac).update(prefix).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  if (grantedAtMs > now + FUTURE_SKEW_MS) return null;
  if (now >= expiresAtMs) return null;
  return {
    browserId,
    browserHash: createHmac('sha256', keys.browser).update(browserId).digest('base64url'),
    consentVersion,
    grantedAt: new Date(grantedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function signConsent(keys: ConsentKeys, browserId: string, consentVersion: number, grantedAtMs: number, expiresAtMs: number): string {
  const prefix = `v1.${browserId}.${consentVersion}.${grantedAtMs}.${expiresAtMs}`;
  const mac = createHmac('sha256', keys.mac).update(prefix).digest('base64url');
  const token = `${prefix}.${mac}`;
  if (token.length > ANALYTICS_COOKIE_MAX_LENGTH || /[\r\n;]/.test(token)) throw new Error('consent cookie');
  return token;
}

function cookieHeader(token: string, secure: boolean, extra: string[]): string {
  const parts = [`${ANALYTICS_COOKIE_NAME}=${token}`, `Path=${ANALYTICS_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', ...extra];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function grantCookie(token: string, expiresAtMs: number, now: number, secure: boolean): string {
  const maxAge = Math.max(1, Math.ceil((expiresAtMs - now) / 1000));
  return cookieHeader(token, secure, [`Max-Age=${maxAge}`, `Expires=${new Date(expiresAtMs).toUTCString()}`]);
}

function clearCookie(secure: boolean): string {
  return cookieHeader('', secure, ['Max-Age=0', `Expires=${CLEARED_EXPIRES}`]);
}
