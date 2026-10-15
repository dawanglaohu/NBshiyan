import Link from 'next/link';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { enforceAdminPage, SPEC_PAGE_ROLES } from '@/lib/server/admin/page-access';
import '@/components/admin/specs/specs.css';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await enforceAdminPage(SPEC_PAGE_ROLES, '/admin/specs');
  return (
    <>
      <h1>产品规格</h1>
      <ul className="adm-card spec-list">
        {categoryMeta.map((c) => <li key={c.key}><Link href={`/admin/specs/${c.key}`}>{c.en.keyword}</Link> <span className="spec-meta">{c.key}</span></li>)}
      </ul>
    </>
  );
}
