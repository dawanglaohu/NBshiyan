import type { InquirySummary } from '@/lib/admin/types';
import { canAssignInquiry } from './format';

// 已匿名化询盘（保留期到期 / 手动删除）：PII 字段为 '[deleted]' 或空，邮箱可能是 deleted+…@invalid.invalid。
// 只认 anonymizedAt：后端没返回这个字段时一律当作未匿名化。
export const ANON_LABEL = '已匿名化';
export const isAnonymized = (r: { anonymizedAt?: string | null }) => !!r.anonymizedAt;

/** 中性标签：正常数据状态，不用红色 / 警告色 */
export const ANON_TAG_STYLE = {
  background: 'var(--surface)', color: 'var(--ink-2)', border: '1px solid var(--ink-2)',
  borderRadius: 4, fontSize: 12, padding: '0 6px', display: 'inline-block', lineHeight: '18px',
} as const;
export function AnonTag() { return <span className="adm-anon-tag" data-testid="anon-tag" style={ANON_TAG_STYLE}>{ANON_LABEL}</span>; }

/** 姓名 / 邮箱 / 电话 / 公司：已匿名化时显示标签，否则原值（空值显示 fallback） */
export function piiField(r: { anonymizedAt?: string | null }, value: string | null | undefined, fallback: React.ReactNode = '—'): React.ReactNode {
  if (isAnonymized(r)) return <AnonTag />;
  return value || fallback;
}

export const anonymizedNotice = (anonymizedAt: string, fmt: (iso: string) => string) => `此询盘已于 ${fmt(anonymizedAt)} 按数据保留政策匿名化`;

/** 详情页：已匿名化时回复区和分配下拉框直接隐藏（不是置灰）；分配仍只给 ADMIN（#225） */
export const detailControls = (inq: { anonymizedAt?: string | null }, role?: string) => ({
  showReply: !isAnonymized(inq),
  showAssign: !isAnonymized(inq) && canAssignInquiry(role),
  showAssigneeText: !isAnonymized(inq) && !canAssignInquiry(role),
});

/**
 * 列表「含已匿名化」开关，默认关。打开时请求带 includeAnonymized=true（后端第六轮加、服务端过滤）。
 * 兜底：后端参数上线前接口会返回已匿名化行，这里在已加载的这一页上过滤；
 * 此时 total / 页数仍含已匿名化，某页可能少于 pageSize 条甚至为空。后端上线后此过滤为空操作。
 */
export const filterAnonymized = <T extends Pick<InquirySummary, 'anonymizedAt'>>(rows: T[], include: boolean) =>
  include ? rows : rows.filter((r) => !isAnonymized(r));
export const parseIncludeAnon = (v: string | null) => v === '1';
