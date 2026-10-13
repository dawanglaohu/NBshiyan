import type { Metadata } from 'next';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';

// 隐私政策（#68）：正文来自 docs/privacy-policy.md，构建时读入。
// 草稿阶段：页面带 Draft 横幅、noindex，不进 sitemap；[COMPANY] 等占位符原样显示。
export const dynamic = 'force-static';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Privacy' });
  return {
    title: t('metaTitle'),
    alternates: alternatesFor(locale, '/privacy'),
    robots: { index: false, follow: true }
  };
}

function section(locale: string) {
  const md = readFileSync(path.join(process.cwd(), 'docs/privacy-policy.md'), 'utf8');
  const heading = locale === 'ru' ? '## Русский' : '## English';
  const start = md.indexOf(heading);
  if (start < 0) return '';
  const rest = md.slice(start + heading.length);
  const end = rest.search(/\n## |\n---/);
  return end < 0 ? rest : rest.slice(0, end);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

// 只支持文档里用到的 Markdown 子集：### 标题、- 列表、段落、**粗体**、`代码`；> 引用是内部备注，不展示
function toHtml(md: string) {
  const out: string[] = [];
  let list = false;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (!line || line.startsWith('>')) continue;
    if (line.startsWith('### ')) out.push(`<h2>${inline(line.slice(4))}</h2>`);
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Privacy');
  return (
    <main className="container legal">
      <div className="draft-banner" role="note"><strong>{t('draft')}</strong> {t('draftText')}</div>
      <h1>{t('title')}</h1>
      <div dangerouslySetInnerHTML={{ __html: toHtml(section(locale)) }} />
    </main>
  );
}
