/** 待确认占位符（如 `{{待Ryan确认}}`）：绝不能渲染到页面上。 */
export const PLACEHOLDER_RE = /\{\{[^}]*\}\}/;
export const hasPlaceholder = (s: unknown): boolean => typeof s === 'string' && PLACEHOLDER_RE.test(s);
/** 含占位符的值返回 null，调用方据此不渲染该项 */
export const visible = (s: string | null | undefined): string | null => (s && !hasPlaceholder(s) ? s : null);
