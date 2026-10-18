'use client';
// 侧栏「未归类邮件」入口 + 徽标（仅 ADMIN 渲染；SALES 不显示入口）。GET unassigned/count 60 秒轮询，页面隐藏时暂停；不含 auto / bounce（后端已排除）。
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { mailApi } from '@/lib/admin/mail/api';
import { badgeText } from '@/lib/admin/mail/logic';
import { UNASSIGNED_MAIL_LIVE } from '@/lib/admin/mail/features';

/** #340：UNASSIGNED_MAIL_LIVE 关闭时什么都不渲染，也不启动轮询（轮询在 LiveNav 里，根本不挂载） */
export default function UnassignedNav({ active }: { active: boolean }) {
  return UNASSIGNED_MAIL_LIVE ? <LiveNav active={active} /> : null;
}

function LiveNav({ active }: { active: boolean }) {
  const [n, setN] = useState<number>();
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    const tick = () => { if (document.visibilityState !== 'hidden') mailApi.unassignedCount().then((r) => setN(r.unassigned)).catch(() => {}); };
    const start = () => { clearInterval(t); t = setInterval(tick, 60_000); };
    const vis = () => { if (document.visibilityState === 'visible') { tick(); start(); } else clearInterval(t); };
    tick(); start(); document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [active]);
  const b = badgeText(n);
  return (
    <Link href="/admin/mail/unassigned" aria-current={active ? 'page' : undefined}>
      未归类邮件{b && <span className="count" aria-label={`${n} 封未归类邮件`}>{b}</span>}
    </Link>
  );
}
