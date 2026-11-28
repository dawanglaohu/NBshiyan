import { products } from '@/data/products';
import enMessages from '../../../../messages/en.json';
import { loadCatalog, withPublishedReady } from '@/lib/catalog/catalog';
import type { AccountRole } from '@/lib/contracts';
import { checkAdminSession } from '@/lib/server/admin/guard';
import { adminOutageNotice, enforceAdminPage } from '@/lib/server/admin/page-access';
import { listPublishedModels } from '@/lib/server/published-models';
import StatsContainer from '@/components/admin/stats/StatsContainer';
import type { StatsProductOption } from '@/components/admin/stats/StatsFilters';
import './stats.css';

// 数据看板（M6-T4）：向 ADMIN / SALES / EDITOR 开放，具体来源由服务端 /api/admin/stats 在查询前按角色裁剪。
// 页面自身独立执行 enforceAdminPage，不依赖外层 layout 缓存；仅向客户端传递已验证角色枚举与已发布安全产品列表。
export const dynamic = 'force-dynamic';

const STATS_PAGE_ROLES: readonly AccountRole[] = ['ADMIN', 'SALES', 'EDITOR'];
const PRODUCT_NAMES: Readonly<Record<string, string>> = enMessages.Products.names;

export default async function StatsPage() {
  const gate = await enforceAdminPage(STATS_PAGE_ROLES, '/admin/stats');
  if (!gate.ok) return gate.notice;

  const session = await checkAdminSession([...STATS_PAGE_ROLES]);
  if (!session.ok) {
    return adminOutageNotice('/admin/stats', session.reason === 'internal' ? 'internal' : 'unavailable');
  }

  const catalog = await loadCatalog(async () => withPublishedReady(await listPublishedModels()), 'en', products);
  const productOptions: StatsProductOption[] = catalog.products.map((item) => {
    const readable = PRODUCT_NAMES[item.slug];
    return {
      slug: item.slug,
      label: readable ? `${readable} (${item.slug})` : item.slug,
    };
  });

  return <StatsContainer role={session.user.role} products={productOptions} />;
}
