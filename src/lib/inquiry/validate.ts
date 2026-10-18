// #308 P2-3：询盘第 3 步自定义校验（表单 noValidate，不用浏览器原生气泡）。纯函数，便于单测。
export const CONTACT_FIELDS = ['name', 'email', 'region', 'consent'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
/** 对应 messages 里 Inquiry.validation.* 的键 */
export type ContactErrorKey = 'name' | 'emailRequired' | 'emailInvalid' | 'region' | 'consent';
export type ContactErrors = Partial<Record<ContactField, ContactErrorKey>>;
export type ContactInput = { name: string; email: string; region: string; consent: boolean };

/** 字段 id（错误汇总里的链接跳到这里） */
export const FIELD_ID: Record<ContactField, string> = { name: 'iq-name', email: 'iq-email', region: 'iq-region', consent: 'iq-consent' };
export const errorId = (f: ContactField) => `${FIELD_ID[f]}-err`;

/** 前端只做基本格式检查（有 @ 和点、没有空格）；服务端仍做完整校验（400 invalid） */
export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function fieldError(f: ContactField, c: ContactInput): ContactErrorKey | undefined {
  switch (f) {
    case 'name': return c.name.trim() ? undefined : 'name';
    case 'email': { const v = c.email.trim(); return !v ? 'emailRequired' : EMAIL_RE.test(v) ? undefined : 'emailInvalid'; }
    case 'region': return c.region ? undefined : 'region';
    case 'consent': return c.consent ? undefined : 'consent';
  }
}

/** 点提交时：所有字段，按页面顺序 */
export function validateContact(c: ContactInput): ContactErrors {
  const out: ContactErrors = {};
  for (const f of CONTACT_FIELDS) { const e = fieldError(f, c); if (e) out[f] = e; }
  return out;
}

/** 改的时候：只重新检查已经报错的字段；改对了就去掉，没改对就更新成当前的错误（例如从「必填」变成「格式不对」） */
export function revalidate(prev: ContactErrors, c: ContactInput): ContactErrors {
  let changed = false; const out: ContactErrors = {};
  for (const f of CONTACT_FIELDS) {
    if (!prev[f]) continue;
    const e = fieldError(f, c);
    if (e !== prev[f]) changed = true;
    if (e) out[f] = e;
  }
  return changed ? out : prev;
}

/** 第一个出错的字段（焦点放到这里） */
export const firstError = (e: ContactErrors): ContactField | undefined => CONTACT_FIELDS.find((f) => e[f]);
