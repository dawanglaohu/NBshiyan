// TODO(后端接入): stub until backend PR —— 后端 PR 合入后整文件以后端实现为准，这里只定类型和函数名（#350 §7 答复 1/2/5）。
// 存储（SiteSetting 表，不加列）：`about.enabled` 开关；`about.<locale>` 每语言一个 JSON（含 version，冲突 409）；
// `about.images` 图片文件各语言共用（id、宽高），alt 和说明按图片 id 写在各语言 JSON 里。
// 三个读取函数共用缓存标签 `site-settings`，页面 revalidate 60 兜底。

/** `about.images` 里的一张图（各语言共用） */
export type AboutImageFile = { id: string; width: number; height: number };

/** `about.<locale>` JSON。字段名取自 spec v1 §7 原始问题 1（后端答复采纳），以后端 PR 为准 */
export type AboutLocaleSetting = {
  version: number;
  title: string;
  /** meta description，≤160，选填 */
  summary?: string;
  /** 已经 sanitizeAboutHtml 净化过的 HTML */
  bodyHtml: string;
  /** 关键数字：只来自后台，最多 4 个，没填就不显示 */
  stats?: { value: string; label: string }[];
  /** 按图片 id 写的 alt / 说明 */
  images?: { id: string; alt: string; caption?: string }[];
  homeHeading?: string;
  homeIntro?: string;
  updatedAt?: string;
  updatedById?: string;
};

/** 前台用：某语言的 about 内容，图片已和 `about.images` 合并好宽高 */
export type AboutContent = Omit<AboutLocaleSetting, 'images'> & {
  locale: string;
  images: (AboutImageFile & { alt: string; caption?: string })[];
};

/**
 * Organization JSON-LD 用的公司信息。spec 没有列具体字段，以下全部选填，空的不输出。
 * 产能、面积、人数、认证、交期这类数字不在这里，也不能由代码补默认值。
 */
export type OrganizationSettings = {
  name?: string;
  alternateName?: string;
  legalName?: string;
  description?: string;
  /** https 绝对地址或以 / 开头的站内路径 */
  logo?: string;
  email?: string;
  telephone?: string;
  address?: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    postalCode?: string;
    addressCountry?: string;
  };
  /** 只收 https 链接 */
  sameAs?: string[];
  /** YYYY 或 YYYY-MM-DD */
  foundingDate?: string;
};

/** 开关关闭、该语言未完成或未发布时返回 null（页面据此 404） */
export async function getAboutContent(locale: string): Promise<AboutContent | null> {
  void locale;
  return null;
}

/** 开关开着、内容完整、而且已上线的语言，按 routing.locales 的顺序 */
export async function getPublishedAboutLocales(): Promise<string[]> {
  return [];
}

export async function getOrganizationSettings(): Promise<OrganizationSettings> {
  return {};
}
