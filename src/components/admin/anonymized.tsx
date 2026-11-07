import type { InquirySummary } from '@/lib/admin/types';
import { canAssignInquiry } from './format';
import { REVIEW_THRESHOLD } from '@/lib/admin/api';

// 已匿名化询盘（保留期到期 / 手动删除）：PII 字段为 '[deleted]' 或空，邮箱可能是 deleted+…@invalid.invalid。
// 只认 anonymizedAt：后端没返回这个字段时一律当作未匿名化。
export const ANON_LABEL = '已匿名化';
export const isAnonymized = (r: { anonymizedAt?: string | null }) => !!r.anonymizedAt;

/**
 * 已匿名化标签：11 节 minimalist-flat——2px 黑边 / 0 圆角 / 无阴影，取值写在
 * admin.css 的 .inq-anon-tag 命名域里，不在组件里写死旧 1px/4px 内联值。
 * 中性标签，不用红色 / 警告色；已匿名化正文与邮箱仍不重新显示。
 */
export function AnonTag() { return <span className="inq-anon-tag" data-testid="anon-tag">{ANON_LABEL}</span>; }

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
  /** 已匿名化：状态只读显示纯文本，「标记无效」隐藏 */
  statusEditable: !isAnonymized(inq),
  showInvalidate: !isAnonymized(inq),
  /** 已匿名化：可信度卡片整块不渲染 */
  showTrust: !isAnonymized(inq),
});

/**
 * 列表「含已匿名化」开关，默认关。打开时请求带 includeAnonymized=true（后端第六轮加、服务端过滤）。
 * 兜底：后端参数上线前接口会返回已匿名化行，这里在已加载的这一页上过滤；
 * 此时 total / 页数仍含已匿名化，某页可能少于 pageSize 条甚至为空。后端上线后此过滤为空操作。
 */
export const filterAnonymized = <T extends Pick<InquirySummary, 'anonymizedAt'>>(rows: T[], include: boolean) =>
  include ? rows : rows.filter((r) => !isAnonymized(r));
export const parseIncludeAnon = (v: string | null) => v === '1';

/** 409 = 已匿名化（后端拦截改状态 / 回复 / 分配） */
export const ANON_CONFLICT_MSG = '此询盘已匿名化，无法修改';
export const isAnonConflict = (err?: string) => err === 'anonymized';
export function StatusText({ label }: { label: string }) {
  return <span className="muted" data-testid="status-text" style={{ color: 'var(--ink-2)' }}>状态：{label}</span>;
}
export function AnonConflictNotice() {
  return <p data-testid="anon-conflict" role="status" style={{ color: 'var(--ink-2)', margin: '0 0 12px' }}>{ANON_CONFLICT_MSG}</p>;
}

/** 待核实（可信度 < 阈值）：已匿名化询盘不再参与分组 / ⚠ / 警告色 */
export const needsReview = (r: { trustScore: number; anonymizedAt?: string | null }) => !isAnonymized(r) && r.trustScore < REVIEW_THRESHOLD;

/** 往来记录：已匿名化时 subject / 正文的 [deleted] 不直接显示 */
export const DELETED_BODY = '内容已删除';
export function DeletedBody() { return <span data-testid="deleted-body" style={{ color: 'var(--ink-2)' }}>{DELETED_BODY}</span>; }

/** 已匿名化：状态下拉框置灰 + 说明（后台界面只有中文；EN/RU 文案待语言 bot 校对后再接入） */
export const STATUS_LOCKED_MSG = '内容已删除，无法更改状态';
export function LockedStatus({ label }: { label: string }) {
  return (
    <span className="muted" data-testid="status-locked">
      <label>状态：<select value="x" disabled aria-label="状态" aria-describedby="status-locked-why"><option value="x">{label}</option></select></label>
      <span id="status-locked-why" style={{ color: 'var(--ink-2)', marginLeft: 8, fontSize: 12 }}>{STATUS_LOCKED_MSG}</span>
    </span>
  );
}
/** 改状态返回 409 anonymized：显示同一句话并刷新详情 */
export const statusConflictText = (err?: string) => (err === 'anonymized' ? STATUS_LOCKED_MSG : undefined);

/** 列表里已匿名化的行：状态旁一个中性标签，不放长说明。
 *  2px 黑边 / 0 圆角 / 无阴影走 .inq-deleted-tag；保留 --neutral-bg 内联是既有
 *  admin-mail-ui.test.ts:80 的中性背景断言（不是红/警告色），不属被移除的旧边界/圆角。 */
export const DELETED_TAG = '已删除';
export function DeletedTag() {
  return <span className="inq-deleted-tag" data-testid="deleted-tag" style={{ background: 'var(--neutral-bg)' }}>{DELETED_TAG}</span>;
}
