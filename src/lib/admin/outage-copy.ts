/** 后台暂时不可用时的界面文案。默认中文，和后台壳层一致；en / ru 给 Accept-Language。ru 待语言专家审。 */
export type OutageLocale = 'zh' | 'en' | 'ru';
export type OutageKind = 'unavailable' | 'internal';

export const NBSP = '\u00A0';

export const OUTAGE_COPY = {
  zh: {
    title: '服务暂时不可用',
    retry: '重试',
    unavailable: '数据库连接出现问题，这不会让你退出登录，请稍后重试。',
    internal: '服务暂时出错，这不会让你退出登录，请稍后重试。',
  },
  en: {
    title: 'Service temporarily unavailable',
    retry: 'Try again',
    unavailable: "We can't connect to the database right now. This won't sign you out. Please try again shortly.",
    internal: "Something went wrong on our side. This won't sign you out. Please try again shortly.",
  },
  ru: {
    title: 'Сервис временно недоступен',
    retry: 'Повторить',
    unavailable: `Не удалось подключиться к${NBSP}базе данных. Это не${NBSP}приведёт к${NBSP}выходу из${NBSP}системы. Повторите попытку позже.`,
    internal: `Произошла ошибка на${NBSP}сервере. Это не${NBSP}приведёт к${NBSP}выходу из${NBSP}системы. Повторите попытку позже.`,
  },
} as const;

/** 表单认不出错误码时的固定句子。后台表单用中文；en / ru 是同一句。不包含错误码。ru 待语言专家审。 */
export const FORM_GENERIC = {
  zh: '服务暂时出错，请稍后重试。',
  en: 'Something went wrong on our side. Please try again shortly.',
  ru: `На${NBSP}нашей стороне произошла ошибка. Повторите попытку позже.`,
} as const;

export type OutageCopy = { title: string; body: string; retry: string };

/** 只看 Accept-Language 的第一段。认不出就用中文。 */
export function outageLocale(acceptLanguage: string | null | undefined): OutageLocale {
  const first = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('ru')) return 'ru';
  if (first.startsWith('en')) return 'en';
  return 'zh';
}

export function outageLang(acceptLanguage: string | null | undefined): 'zh-CN' | 'en' | 'ru' {
  const locale = outageLocale(acceptLanguage);
  if (locale === 'en') return 'en';
  if (locale === 'ru') return 'ru';
  return 'zh-CN';
}

export function outageCopy(acceptLanguage: string | null | undefined, kind: OutageKind = 'unavailable'): OutageCopy {
  const row = OUTAGE_COPY[outageLocale(acceptLanguage)];
  return { title: row.title, body: row[kind], retry: row.retry };
}

/** 后台表单顶部的一句中文。不带错误码，也不要求重新登录。 */
export function outageFormMessage(): string {
  const copy = OUTAGE_COPY.zh;
  return `${copy.title}。${copy.unavailable}`;
}

/** 白名单之外的表单错误。默认中文，和后台壳层一致。 */
export function outageFormGeneric(locale: OutageLocale = 'zh'): string {
  return FORM_GENERIC[locale];
}
