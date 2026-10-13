import Link from 'next/link';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { adminPageDenied, SPEC_PAGE_ROLES } from '@/lib/server/admin/page-access';
import Denied from '@/components/admin/specs/Denied';
import '@/components/admin/specs/specs.css';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const denied = await adminPageDenied(SPEC_PAGE_ROLES);
  if (denied) return <Denied status={denied} />;
  return (
    <>
      <h1>产品规格</h1>
      <ul className="adm-card spec-list">
        {categoryMeta.map((c) => <li key={c.key}><Link href={`/admin/specs/${c.key}`}>{c.en.keyword}</Link> <span className="spec-meta">{c.key}</span></li>)}
      </ul>
    </>
  );
}
