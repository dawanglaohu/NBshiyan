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

export type AdminRole = 'ADMIN' | 'SALES' | 'EDITOR';
/** GET /api/admin/users → { items: AdminUser[] }（docs/API.md） */
export type AdminUser = { id: string; name: string; email: string; role: AdminRole };
export type Contact = { name: string; email: string; company?: string; phone?: string; region: string };
export type InquiryItem = { productSlug: string; quantity?: number; config?: Record<string, unknown>; designId?: string };
export type TrustReason = { label: string; delta: number };
export type InquiryMessage = { id: string; direction: 'INBOUND' | 'OUTBOUND'; subject: string; bodyHtml: string; authorId?: string | null; author?: string; createdAt: string };
export type InquiryNote = { id: string; authorId?: string; author: string; body: string; createdAt: string };
/** Logo 只在后台经鉴权接口查看；这里只有元数据，预览地址由鉴权接口提供（接入前为占位） */
export type InquiryAttachment = { id: string; kind: 'logo' | 'file'; filename: string; mime: string; sizeBytes: number; scan?: 'clean' | 'pending' | 'infected'; downloadUrl?: string };
export type HistoryEvent = { id: string; at: string; actor?: string; action: string };

export type InquirySummary = {
  id: string; ref: string; status: InquiryStatus; source: InquirySource; locale: Locale;
  contact: Pick<Contact, 'name' | 'email' | 'company' | 'region'>;
  products: { productSlug: string; quantity?: number }[];
  trustScore: number; assignee?: AdminUser; createdAt: string;
  /** 产品条数（列表接口只给 _count.items，没有产品明细时用它显示） */
  itemCount?: number;
  /** 已匿名化时间（ISO）。详情接口（include 全字段）会返回；列表接口 select 目前没有这个字段，缺失按未匿名化处理 */
  anonymizedAt?: string | null;
};
export type InquiryDetail = InquirySummary & {
  contact: Contact; message?: string; items: InquiryItem[]; trustReasons: TrustReason[];
  attribution?: { page?: string; utm?: Record<string, string> };
  ipCountry?: string; messages: InquiryMessage[]; notes: InquiryNote[];
  attachments: InquiryAttachment[]; history: HistoryEvent[];
  /** 客户上传的 Logo（#59）；预览走鉴权接口 GET /api/admin/uploads/:id */
  logoUploadId?: string;
};

export type InquiryQuery = {
  status?: InquiryStatus | 'REVIEW'; q?: string; from?: string; to?: string;
  product?: string; minScore?: number; maxScore?: number;
  /** 'me' | 'none'（未分配）| 用户 id；业务员角色后端只返回自己的 */
  assignee?: string; page?: number; pageSize?: number;
  /** 含已匿名化（后端第六轮加，默认 false 由服务端过滤）；只在开关打开时传 true，关时不传 */
  includeAnonymized?: boolean;
};
export type InquiryPatchResult = { id: string; status: InquiryStatus; assigneeId: string | null; updatedAt: string };
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export interface AdminApi {
  listInquiries(q: InquiryQuery): Promise<Page<InquirySummary>>;
  getInquiry(id: string): Promise<InquiryDetail | null>;
  /** PATCH → { id, status, assigneeId, updatedAt }；调用方随后重新拉详情 */
  updateInquiry(id: string, patch: { status?: InquiryStatus; assigneeId?: string | null }): Promise<InquiryPatchResult>;
  /** 正文为纯文本（≤20000），服务端转义、换行转 <br> */
  reply(id: string, body: { subject: string; body: string }): Promise<InquiryMessage>;
  addNote(id: string, body: string): Promise<InquiryNote>;
  listUsers(): Promise<AdminUser[]>;
  /** 返回可直接用于 <img src> 的地址（blob: 或 data:），调用方用完后 revoke */
  logoPreview(uploadId: string): Promise<string>;
}

/** Wire shape of GET /api/admin/users; a bare array is tolerated for older backends. */
export type AdminUsersResponse = { items: AdminUser[] } | AdminUser[];
export function usersFromResponse(res: AdminUsersResponse | null | undefined): AdminUser[] {
  if (Array.isArray(res)) return res;
  return Array.isArray(res?.items) ? res.items : [];
}
