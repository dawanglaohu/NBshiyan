// 输出 JSON-LD 结构化数据（全站唯一的 <script type="application/ld+json"> 出口）。
// 转义 < > & U+2028 U+2029 为 \u003c \u003e \u0026 \u2028 \u2029：防止 </script> 截断、HTML 注释/实体解析和 JS 行终止符问题。
// 这些都在 JSON 字符串内部（JSON 结构字符里没有这五个），JSON.parse 后与原对象完全相同。
const ESCAPES: Record<string, string> = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' };

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (c) => ESCAPES[c]);
}

export default function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
