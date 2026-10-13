// 后台询盘数据类型：与 prisma/schema.prisma 和 docs/API.md「后台接口」对齐。
// 接口返回 JSON，日期为 ISO 字符串。
export type InquiryStatus = 'NEW' | 'FOLLOWING' | 'QUOTED' | 'WON' | 'INVALID';
export type InquirySource = 'FORM' | 'WIZARD' | 'CART' | 'CUSTOMIZER' | 'SAMPLE';
export type Locale = 'en' | 'ru';

export const STATUS_LABEL: Record<InquiryStatus, string> = {
  NEW: '新询盘', FOLLOWING: '跟进中', QUOTED: '已报价', WON: '已成交', INVALID: '无效'
};
export const SOURCE_LABEL: Record<InquirySource, string> = {
  FORM: '询价表单', WIZARD: '询价向导', CART: '询价清单', CUSTOMIZER: '定制器', SAMPLE: '样品申请'
};
/** PRD 第 9 节：可信度低于 40 分归入“待核实” */
export const REVIEW_THRESHOLD = 40;

export type AdminUser = { id: string; name: string };
export type Contact = { name: string; email: string; company?: string; phone?: string; region: string };
export type InquiryItem = { productSlug: string; quantity?: number; config?: Record<string, unknown>; designId?: string };
export type TrustReason = { label: string; delta: number };
export type InquiryMessage = { id: string; direction: 'INBOUND' | 'OUTBOUND'; subject: string; bodyHtml: string; author?: string; createdAt: string };
export type InquiryNote = { id: string; author: string; body: string; createdAt: string };
/** Logo 只在后台经鉴权接口查看；这里只有元数据，预览地址由鉴权接口提供（接入前为占位） */
export type InquiryAttachment = { id: string; kind: 'logo' | 'file'; filename: string; mime: string; sizeBytes: number };
export type HistoryEvent = { id: string; at: string; actor?: string; action: string };

export type InquirySummary = {
  id: string; ref: string; status: InquiryStatus; source: InquirySource; locale: Locale;
  contact: Pick<Contact, 'name' | 'email' | 'company' | 'region'>;
  products: { productSlug: string; quantity?: number }[];
  trustScore: number; assignee?: AdminUser; createdAt: string;
};
export type InquiryDetail = InquirySummary & {
  contact: Contact; message?: string; items: InquiryItem[]; trustReasons: TrustReason[];
  attribution?: { page?: string; utm?: Record<string, string> };
  ipCountry?: string; messages: InquiryMessage[]; notes: InquiryNote[];
  attachments: InquiryAttachment[]; history: HistoryEvent[];
};

export type InquiryQuery = {
  status?: InquiryStatus | 'REVIEW'; q?: string; from?: string; to?: string;
  region?: string; product?: string; minScore?: number; mine?: boolean; page?: number; pageSize?: number;
};
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export interface AdminApi {
  listInquiries(q: InquiryQuery): Promise<Page<InquirySummary>>;
  getInquiry(id: string): Promise<InquiryDetail | null>;
  updateInquiry(id: string, patch: { status?: InquiryStatus; assigneeId?: string | null }): Promise<InquiryDetail>;
  reply(id: string, body: { subject: string; bodyHtml: string }): Promise<InquiryMessage>;
  addNote(id: string, body: string): Promise<InquiryNote>;
  listUsers(): Promise<AdminUser[]>;
}
