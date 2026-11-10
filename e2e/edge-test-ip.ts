/**
 * e2e 专用受限入口：应用只认 `X-Edge-Auth` + `CF-Connecting-IP`（src/lib/edge/client-ip.ts），
 * 密钥须 ≥ 32 字节。这里给每个询盘调用点分配一个**显式常量** IP：
 * - 不按哈希派生（截断后的碰撞概率无法证明为 0），不按进程内序号分配（多 worker 各自从 1 开始会撞）；
 * - 唯一性由静态表本身保证，模块加载时再断言一次；调用点必须传表内名字，否则直接抛错。
 * 不关限流、不改产品额度、不读 X-Forwarded-For；密钥是 CI/本地 e2e 假值，不是生产密钥。
 */

/** 与 playwright.config.ts 的 webServer env 同源；CI 可用 E2E_EDGE_AUTH_SECRET 覆盖。 */
export const E2E_EDGE_AUTH_SECRET =
  process.env.E2E_EDGE_AUTH_SECRET ?? 'ci-e2e-only-edge-auth-not-for-production-0001';

// client-ip.ts 对 <32 字节的密钥 fail-closed；这里提前失败，避免“客户端照发头、服务端静默退回 untrusted”。
if (new TextEncoder().encode(E2E_EDGE_AUTH_SECRET).length < 32) {
  throw new Error('E2E_EDGE_AUTH_SECRET must be at least 32 bytes; client-ip would treat every request as untrusted');
}

/**
 * 198.18.0.0/15 benchmark 段；key 是询盘调用点，value 必须全局唯一。
 * 同一个 key 在同一个应用进程内的询盘 POST 次数必须 ≤ 5（限流上限）。
 * CI 的 A3 分段各自重启应用进程（.github/workflows/ci.yml “各自重启 Playwright 管理的应用，隔离 memory 限流”），
 * 因此不同分段的调用点即使同名也不会互相计数。
 */
const SITE_IPS = {
  'product-inquiry:en-card': '198.18.10.1',
  'product-inquiry:ru-390': '198.18.10.2',
  'product-inquiry:en-390': '198.18.10.3',
  'product-inquiry:api-400': '198.18.10.4',
  'product-inquiry:api-201': '198.18.10.5',
  'admin-legacy:list-flow': '198.18.10.6',
  'admin-legacy:form-density': '198.18.10.7',
  'admin-legacy:sales-404-403': '198.18.10.8',
  'admin-legacy:error-400': '198.18.10.9',
  'admin-legacy:anon-a': '198.18.10.10',
  'admin-legacy:anon-b': '198.18.10.11',
  'admin-legacy:flow-views': '198.18.10.12',
} as const;

export type EdgeTestSite = keyof typeof SITE_IPS;

/** 只读表：静态核验脚本与离线探针读同一份数据。 */
export const EDGE_TEST_IPS: Readonly<Record<EdgeTestSite, string>> = Object.freeze(SITE_IPS);

/** 表内 IP 必须两两不同；重复即抛错（构造保证，不是概率保证）。 */
export function assertUniqueEdgeIps(table: Readonly<Record<string, string>>): void {
  const seen = new Map<string, string>();
  for (const [site, ip] of Object.entries(table)) {
    const prev = seen.get(ip);
    if (prev !== undefined) throw new Error(`duplicate edge test IP ${ip}: ${prev} / ${site}`);
    seen.set(ip, site);
  }
}

assertUniqueEdgeIps(SITE_IPS);

/** 直接用于 context.setExtraHTTPHeaders / newContext(extraHTTPHeaders) / apiRequest headers。 */
export function trustedEdgeHeaders(site: EdgeTestSite): Record<string, string> {
  if (!Object.prototype.hasOwnProperty.call(SITE_IPS, site)) {
    throw new Error(`unknown edge test site: ${String(site)}`);
  }
  return { 'x-edge-auth': E2E_EDGE_AUTH_SECRET, 'cf-connecting-ip': SITE_IPS[site] };
}
