/** 后台数据库不可用时的界面文案。默认中文，和后台壳层一致；en / ru 给 Accept-Language。ru 待语言专家审。 */
export type OutageLocale = 'zh' | 'en' | 'ru';

export const OUTAGE_COPY = {
  zh: {
    title: '服务暂时不可用',
    body: '数据库连接出现问题，你的登录状态仍然有效',
    retry: '重试',
  },
  en: {
    title: 'Service temporarily unavailable',
    body: 'The database connection has a problem. Your sign-in is still valid.',
    retry: 'Try again',
  },
  ru: {
    title: 'Сервис временно недоступен',
    body: 'Не удалось подключиться к базе данных. Ваш вход по-прежнему действителен.',
    retry: 'Повторить',
  },
} as const;

export type OutageCopy = (typeof OUTAGE_COPY)[OutageLocale];

/** 只看 Accept-Language 的第一段。认不出就用中文。 */
export function outageLocale(acceptLanguage: string | null | undefined): OutageLocale {
  const first = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('ru')) return 'ru';
  if (first.startsWith('en')) return 'en';
  return 'zh';
}

export function outageCopy(acceptLanguage: string | null | undefined): OutageCopy {
  return OUTAGE_COPY[outageLocale(acceptLanguage)];
}

/** 后台表单顶部的一句中文。不带错误码，也不要求重新登录。 */
export function outageFormMessage(): string {
  const copy = OUTAGE_COPY.zh;
  return `${copy.title}。${copy.body}`;
}
