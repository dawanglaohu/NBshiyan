// 短链接页“暂时不可用”（数据库不可用时）。文案内置英俄两版，不依赖其它服务。
const COPY = {
  en: { title: 'Temporarily unavailable', text: 'Temporarily unavailable, please try again later.', meta: 'Temporarily unavailable | PackJoyU' },
  ru: { title: 'Временно недоступно', text: 'Временно недоступно, пожалуйста, попробуйте позже.', meta: 'Временно недоступно | PackJoyU' },
} as const;
const pick = (locale: string) => (locale === 'ru' ? COPY.ru : COPY.en);
export const unavailableTitle = (locale: string) => pick(locale).meta;

export function UnavailableNotice({ locale }: { locale: string }) {
  const t = pick(locale);
  return (
    <main className="container legal" data-design-state="unavailable" style={{ textAlign: 'center' }}>
      <h1>{t.title}</h1>
      <p>{t.text}</p>
    </main>
  );
}
