import sanitizeHtml from 'sanitize-html';

/**
 * #350 about 正文净化（和入站邮件的 mail/sanitize.ts 分开，规则更严）。入库前、读出后各调用一次，结果幂等。
 * - 标签只留 p h2 h3 strong em a ul ol li br；script / style / iframe 等连内容一起丢掉，其余不在白名单的标签去掉、保留文字
 * - 唯一允许的输入属性是 <a href>；style、class、id、on* 一律去掉
 * - href 只允许 https:、mailto:，或以 `/` 开头且不以 `//`、`/\` 开头的站内路径；判断前先去掉空白和控制字符、不区分大小写；
 *   实体（解析器已解码）和百分号编码的变体也按解码后的结果判断。不合格的链接去掉 <a>，保留文字
 * - 每个保留下来的 <a> 统一加 rel="noopener noreferrer"，不加 target
 */
export const ABOUT_TAGS = ['p', 'h2', 'h3', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'br'] as const;
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'textarea', 'select', 'option', 'noscript', 'title', 'head', 'template', 'xmp', 'noembed', 'noframes'];
export const ABOUT_LINK_REL = 'noopener noreferrer';

// C0/C1 控制字符、各种空白、零宽字符和 BOM：浏览器解析 URL 时会忽略其中一部分，判断前统一去掉
const STRIP_IN_URL = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/g;

/** 路径里有 `.` 或 `..` 段（百分号解码后判断），URL 规范化后可能变成 `//host`，一律拒绝 */
export function hasDotSegment(path: string): boolean {
  const p = path.split(/[?#]/, 1)[0];
  return p.split('/').some((seg) => { const d = percentDecode(seg).replace(STRIP_IN_URL, ''); return d === '.' || d === '..'; });
}

function percentDecode(s: string): string {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try { next = decodeURIComponent(cur); } catch { return cur; }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** 返回可以写进 href 的值；不合格返回 null。输入是解析器已经解码过实体的属性值。 */
export function safeAboutHref(raw: string): string | null {
  const v = raw.replace(STRIP_IN_URL, '');
  if (!v) return null;
  if (v.startsWith('/')) {
    // 站内路径：`//host` 和 `/\host` 会被浏览器当成协议相对地址；百分号解码后再查一遍；路径里不允许反斜杠
    const dec = percentDecode(v).replace(STRIP_IN_URL, '');
    if (v[1] === '/' || v[1] === '\\' || dec[1] === '/' || dec[1] === '\\' || v.includes('\\') || dec.includes('\\')) return null;
    if (hasDotSegment(v)) return null;
    try {
      const u = new URL(v, 'https://site.invalid');
      if (u.origin !== 'https://site.invalid') return null;
      const out = u.pathname + u.search + u.hash;
      // 规范化之后再查一次：不能变成协议相对地址
      if (out[1] === '/' || out[1] === '\\' || percentDecode(out)[1] === '/' || percentDecode(out)[1] === '\\') return null;
      return out;
    } catch { return null; }
  }
  const lower = v.toLowerCase();
  if (lower.startsWith('https:')) {
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
      return u.href;
    } catch { return null; }
  }
  if (lower.startsWith('mailto:')) {
    try {
      const u = new URL(v);
      if (u.protocol !== 'mailto:' || u.pathname.length < 3 || !u.pathname.includes('@')) return null;
      // 只允许 subject 参数（不允许 cc / bcc / body 等）
      if ([...u.searchParams.keys()].some((k) => k.toLowerCase() !== 'subject')) return null;
      return u.href;
    } catch { return null; }
  }
  return null; // javascript:、data:、vbscript:、http:、相对路径、编码变体等一律拒绝
}

export function sanitizeAboutHtml(input: string): string {
  if (typeof input !== 'string' || !input) return '';
  const html = sanitizeHtml(input, {
    allowedTags: [...ABOUT_TAGS],
    allowedAttributes: { a: ['href', 'rel'] }, // rel 只由下面的 transformTags 写入，输入里的 rel 会被覆盖
    nonTextTags: DROP_WITH_CONTENT,
    disallowedTagsMode: 'discard',
    allowedSchemes: ['https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    allowVulnerableTags: false,
    parseStyleAttributes: false,
    transformTags: {
      // 注意：不能把不合格的 <a> 改名成 span 来去掉——sanitize-html 按原标签名记录改名，后面合格 <a> 的闭合标签会被写成 </span>。
      // 这里不改名，不合格的链接输出成不带属性的 <a>，再由 unwrapBareLinks 去掉标签、保留文字。
      a: (_tagName, attribs): sanitizeHtml.Tag => {
        const href = safeAboutHref(attribs.href ?? '');
        return href ? { tagName: 'a', attribs: { href, rel: ABOUT_LINK_REL } } : { tagName: 'a', attribs: {} };
      },
    },
  });
  return unwrapBareLinks(html);
}

/**
 * 输入是 sanitize-html 的输出：标签成对、属性值已转义；<a> 只有两种形态——`<a href="…" rel="noopener noreferrer">` 或不带属性的 `<a>`。
 * 按栈匹配，去掉不带属性的 <a> 及其对应的 </a>，保留中间的文字。
 */
function unwrapBareLinks(html: string): string {
  const stack: boolean[] = []; // true = 要去掉的 <a>
  return html.replace(/<a>|<a\s[^>]*>|<\/a>/g, (tag) => {
    if (tag === '</a>') return stack.pop() ? '' : tag;
    const bare = tag === '<a>';
    stack.push(bare);
    return bare ? '' : tag;
  });
}

/** 净化后的正文转纯文本，用于长度和「内容是否完整」判断 */
export function aboutHtmlToText(html: string): string {
  return decodeBasicEntities(sanitizeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|h2|h3|li)>/gi, '\n'), { allowedTags: [], allowedAttributes: {}, nonTextTags: DROP_WITH_CONTENT }))
    .replace(/\n{3,}/g, '\n\n').trim();
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };
const decodeBasicEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e: string) => ENT[e]);

// 纯文本字段：去掉控制字符（多行字段保留 \n）、零宽字符；不允许 HTML 标签
const CTRL_SINGLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const CTRL_MULTI = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * 标题、摘要、关键数字、首页区块、图片 alt/说明：去掉标签和控制字符，按纯文本保存（前台按文本渲染，不进 innerHTML）。
 * multiline=true 时保留换行（\r\n 统一成 \n，最多连续两个）。
 */
export function cleanPlainText(input: string, multiline = false): string {
  if (typeof input !== 'string') return '';
  const noTags = decodeBasicEntities(sanitizeHtml(input, { allowedTags: [], allowedAttributes: {}, nonTextTags: DROP_WITH_CONTENT }));
  const s = noTags.replace(/\r\n?/g, '\n');
  if (!multiline) return s.replace(CTRL_SINGLE, ' ').replace(/\s+/g, ' ').trim();
  return s.replace(CTRL_MULTI, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
