import sanitizeHtml from 'sanitize-html';
import { domainToASCII } from 'node:url';

/**
 * 入站邮件 HTML 白名单净化（backend-plan v4 §6 M2 + §18）。入库前调用，输出只给 sandbox iframe 显示。
 * - 只留白名单标签；script / style / iframe / object / embed / svg / math / form / textarea / select / noscript / title 连内容一起丢掉；
 *   base / meta / link 等不在白名单的空元素直接去掉
 * - 去掉全部 on* 事件属性、srcset、background、formaction（白名单里根本没有）
 * - style 属性只留安全子集；值里出现 url( / expression / @import / behavior 整条声明丢掉；position 不在白名单
 * - 链接：href 只允许 http / https / mailto，其他（javascript:、data: 等）整段降为纯文本；
 *   每个 <a> 强制 target="_blank" rel="noopener noreferrer" title="<完整 URL>"；显示文字像网址但主机名不同 → data-mismatch="1"
 * - 图片：http(s) 外链改成 data-remote-src（不加载），hasRemoteImages=true；cid: 内联图第 1 阶段只留占位；
 *   只放行 data:image/(png|jpeg|gif|webp)（§18 例外），data:image/svg+xml 和其他 data: 去掉
 */
const TAGS = ['p', 'br', 'b', 'i', 'u', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'blockquote', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'span', 'div', 'img'];
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'textarea', 'select', 'option', 'noscript', 'title', 'head', 'template'];

const BAD_CSS = /url\s*\(|expression|@import|behavior|javascript:|\\/i;
const SAFE_CSS_VAL = /^[#a-z0-9.,%\s()'"-]{1,100}$/i;
const cssOk = [{ test: (v: string) => SAFE_CSS_VAL.test(v) && !BAD_CSS.test(v) }] as unknown as RegExp[];
const STYLE_PROPS = ['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-align', 'text-decoration', 'text-transform', 'text-indent', 'line-height', 'vertical-align', 'white-space', 'width', 'max-width', 'border', 'border-collapse',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
const allowedStyles = { '*': Object.fromEntries(STYLE_PROPS.map((p) => [p, cssOk])) };

const DATA_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** 「显示文字像网址」：http(s):// 或 www. 开头，或整段是「域名.顶级域」（可带路径） */
export function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  return /^(https?:\/\/|www\.)/i.test(t) || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9\u00a1-\uffff](?:[a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?)*\.[a-z\u00a1-\uffff]{2,}(?:[/?#]\S*)?$/i.test(t);
}
/** 主机名比对用：小写、去掉开头 www.、IDN 转 punycode */
export function normHost(h: string): string {
  const a = domainToASCII(h.trim().toLowerCase().replace(/\.$/, '')) || h.trim().toLowerCase();
  return a.replace(/^www\./, '');
}
function hostOfText(text: string): string | null {
  const t = text.trim();
  try { return normHost(new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`).hostname); } catch { return null; }
}

export type SanitizeResult = { html: string; hasRemoteImages: boolean };

export function sanitizeInboundHtml(input: string): SanitizeResult {
  let hasRemoteImages = false;
  const html = sanitizeHtml(input, {
    allowedTags: TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel', 'data-mismatch'],
      img: ['src', 'alt', 'width', 'height', 'data-remote-src', 'data-cid'],
      td: ['colspan', 'rowspan', 'align'], th: ['colspan', 'rowspan', 'align'],
      '*': ['style'],
    },
    allowedStyles,
    nonTextTags: DROP_WITH_CONTENT,
    disallowedTagsMode: 'discard',
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    parseStyleAttributes: true,
    transformTags: {
      a: (tagName, attribs) => {
        const href = (attribs.href ?? '').trim();
        let url: URL | null = null;
        try { url = new URL(href); } catch { url = null; }
        if (!url || !['http:', 'https:', 'mailto:'].includes(url.protocol)) {
          // 不安全或无法解析的链接：去掉 <a>，保留文字（下面 exclusiveFilter 不动文字）
          return { tagName: 'span', attribs: {} };
        }
        const out: Record<string, string> = { href: url.href, target: '_blank', rel: 'noopener noreferrer', title: url.href };
        return { tagName: 'a', attribs: out };
      },
      img: (tagName, attribs) => {
        const src = (attribs.src ?? '').trim();
        const keep: Record<string, string> = {};
        for (const k of ['alt', 'width', 'height']) if (attribs[k]) keep[k] = attribs[k];
        if (/^https?:\/\//i.test(src)) { hasRemoteImages = true; return { tagName: 'img', attribs: { ...keep, 'data-remote-src': src } }; }
        if (/^cid:/i.test(src)) return { tagName: 'img', attribs: { ...keep, 'data-cid': '1' } };
        if (DATA_IMG.test(src)) return { tagName: 'img', attribs: { ...keep, src } };
        return { tagName: 'img', attribs: keep };
      },
    },
  });
  return { html: markMismatches(html), hasRemoteImages };
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENT[e]);

/**
 * 第二遍：给「显示文字像网址但主机名与 href 不同」的链接加 data-mismatch="1"（mailto 不比对）。
 * 输入是第一遍 sanitize-html 的输出：<a> 只有 href/target/rel/title 四个属性、值已转义（不含 "），且 <a> 不嵌套。
 */
function markMismatches(html: string): string {
  return html.replace(/<a href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (all, hrefEsc: string, rest: string, inner: string) => {
    const href = decode(hrefEsc);
    if (/^mailto:/i.test(href)) return all;
    const text = decode(inner.replace(/<[^>]*>/g, ''));
    if (!looksLikeUrl(text)) return all;
    const shown = hostOfText(text);
    let real: string | null = null;
    try { real = normHost(new URL(href).hostname); } catch { real = null; }
    return shown && real && shown !== real ? `<a href="${hrefEsc}"${rest} data-mismatch="1">${inner}</a>` : all;
  });
}

/** 纯文本摘要 / bodyText：去掉所有标签 */
export function htmlToText(html: string): string {
  return sanitizeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|blockquote)>/gi, '\n'), { allowedTags: [], allowedAttributes: {}, nonTextTags: DROP_WITH_CONTENT })
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
