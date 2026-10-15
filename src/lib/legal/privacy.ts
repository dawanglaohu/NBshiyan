import { visible } from '../placeholder';

/**
 * 唯一开关：隐私页是否已定稿。false 时页面 noindex 且不进 sitemap，两者一起切换。
 * 公司主体、联系邮箱等 {{待Ryan确认}} 占位符全部替换后再改为 true。
 */
export const PRIVACY_PAGE_COMPLETE = false;
export const PRIVACY_PATH = '/privacy';

export const SECTION_KEYS = ['collected', 'purpose', 'retention', 'cookies', 'chat', 'contact', 'company'] as const;
export const RETENTION_KEYS = ['designs', 'logos', 'sampleEmail', 'rateLimit', 'audit', 'adminSessions', 'inquiries', 'inquiriesContact', 'onRequest', 'oldReplies', 'exports', 'cleanup'] as const;

type Msgs = Record<string, unknown>;
export type PrivacySection = { key: string; title: string; paragraphs: string[]; items: string[] };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : v && typeof v === 'object' ? Object.values(v).map(str) : []);

/** 把 messages.Privacy 变成可渲染结构；任何含占位符的文本都被丢弃（不渲染） */
export function buildPrivacy(p: Msgs): { title: string; intro: string | null; sections: PrivacySection[] } {
  const sections = (p.sections ?? {}) as Record<string, Msgs>;
  const out: PrivacySection[] = [];
  for (const key of SECTION_KEYS) {
    const s = sections[key] ?? {};
    const items = key === 'retention'
      ? RETENTION_KEYS.map((k) => str((s.items as Msgs | undefined)?.[k]))
      : list(s.items);
    const sec = {
      key,
      title: str(s.title),
      paragraphs: list(s.text).map(visible).filter((x): x is string => !!x),
      items: items.map(visible).filter((x): x is string => !!x)
    };
    if (sec.title && (sec.paragraphs.length || sec.items.length || key === 'contact')) out.push(sec);
  }
  return { title: str(p.title), intro: visible(str(p.intro)), sections: out };
}

/** 页面是否可索引：只有定稿开关打开，且文案里没有任何占位符 */
export function privacyIndexable(p: Msgs, complete = PRIVACY_PAGE_COMPLETE): boolean {
  return complete && !JSON.stringify(p).match(/\{\{[^}]*\}\}/);
}

/** 下发给客户端的 messages：去掉仅服务端使用的 Privacy（避免占位符出现在页面源码里） */
export function clientMessages<T extends Record<string, unknown>>(m: T): Omit<T, 'Privacy'> {
  const { Privacy: _omit, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}
