import type { AdminApi, AdminUser, AdminUsersResponse, InquiryDetail, InquiryStatus, InquirySummary } from './types';
import { REVIEW_THRESHOLD, STATUS_LABEL, usersFromResponse } from './types';
import { historyPageFrom, HISTORY_MAX_LIMIT, HISTORY_PAGE_SIZE, type HistoryItem, type HistoryType } from './history';

// 示例数据，仅用于后台页面开发；接入真实接口后不再使用
const users: AdminUser[] = [{ id: 'u1', name: '业务员 A', email: 'sales-a@packjoyu.example', role: 'SALES' }, { id: 'u2', name: '业务员 B', email: 'sales-b@packjoyu.example', role: 'SALES' }];
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const PRODUCTS = ['wine-boxes', 'paper-cups', 'corrugated-boxes', 'gift-boxes', 'pulp-molding', 'color-boxes'];
const COMPANIES: [string, string, string][] = [
  ['Acme GmbH', 'DE', 'anna@acme.de'], ['ООО Ромашка', 'RU', 'ivan@romashka.ru'], ['', 'US', 'buyer123@gmail.com'],
  ['Bloom Co', 'AU', 'sam@bloom.co'], ['Nordic Tea AB', 'SE', 'lena@nordictea.se'], ['Maison Vin', 'FR', 'paul@maisonvin.fr']
];
const STATUSES: InquiryStatus[] = ['NEW', 'FOLLOWING', 'NEW', 'QUOTED', 'WON', 'INVALID'];
/** mock 内部记录：详情 + 时间线（时间线只通过 getHistory 下发，与真实接口一致） */
type Row = InquiryDetail & { history: HistoryItem[] };
const ME = { name: '我', role: 'ADMIN' };
const ADMIN = { name: '管理员', role: 'ADMIN' };
let seq = 0;
const ev = (type: HistoryType, at: string, actor: HistoryItem['actor'], summary: string): HistoryItem => ({ type, at, actor, summary, cursor: `mock-${++seq}` });

function make(i: number): Row {
  const [company, region, email] = COMPANIES[i % COMPANIES.length];
  const slug = PRODUCTS[i % PRODUCTS.length];
  const score = [86, 72, 31, 64, 91, 18][i % 6] - (i >= 6 ? 3 : 0);
  const status = STATUSES[i % STATUSES.length];
  const assignee = status === 'NEW' ? undefined : users[i % 2];
  const createdAt = ago(10 + i * 397);
  const locale = region === 'RU' ? 'ru' : 'en';
  return {
    id: `inq_${i + 1}`, ref: `PJ-2610-${(1_234_567 + i * 7919).toString(36).toUpperCase().slice(-6)}`,
    status, source: (['WIZARD', 'FORM', 'CART', 'CUSTOMIZER', 'SAMPLE'] as const)[i % 5], locale,
    contact: { name: ['Anna Weber', 'Иван Петров', 'J. Smith', 'Sam Lee', 'Lena Berg', 'Paul Martin'][i % 6], email, company: company || undefined, phone: i % 2 ? '+49 30 1234567' : undefined, region },
    products: [{ productSlug: slug, quantity: 5000 * ((i % 3) + 1) }, ...(i % 4 === 0 ? [{ productSlug: 'gift-boxes', quantity: 2000 }] : [])],
    trustScore: score, assignee, createdAt,
    message: locale === 'ru' ? 'Здравствуйте! Нужны коробки с логотипом, тираж 5000. Срок — 4 недели.' : 'Hi, we need custom printed boxes with our logo, 5,000 pcs. See https://acme.example/brand for brand colors.',
    items: [{ productSlug: slug, quantity: 5000 * ((i % 3) + 1), config: { size: '30×20×10 cm', material: 'Kraft 350g', finish: 'Matte' }, designId: i % 2 ? undefined : 'abc123XYZ0' }],
    trustReasons: score >= REVIEW_THRESHOLD
      ? [{ label: '企业邮箱域名', delta: 20 }, { label: '填写了公司名', delta: 10 }, { label: 'IP 国家与填写国家一致', delta: 6 }]
      : [{ label: '免费邮箱', delta: -10 }, { label: '留言含外链', delta: -9 }, { label: 'IP 国家与填写国家不一致', delta: -10 }],
    attribution: { page: `/en/products/${slug}`, utm: { utm_source: 'google', utm_term: 'custom wine box' } },
    ipCountry: score < REVIEW_THRESHOLD ? 'NG' : region,
    messages: [
      { id: 'm1', direction: 'INBOUND', subject: '首次询盘', bodyHtml: '<p>首次询盘内容…</p>', createdAt },
      ...(status !== 'NEW' ? [{ id: 'm2', direction: 'OUTBOUND' as const, subject: 'Re: Quote', bodyHtml: '<p>报价单已发，请查收。</p>', author: assignee?.name, createdAt: ago(5 + i * 300) }] : [])
    ],
    notes: status === 'NEW' ? [] : [{ id: 'n1', author: assignee?.name ?? '—', body: '客户要求 4 周内交货，@业务员 B 确认产能', createdAt: ago(60) }],
    attachments: i % 3 === 0 ? [{ id: 'a1', kind: 'file', filename: 'artwork-v2.png', mime: 'image/png', sizeBytes: 1_258_291, scan: 'clean' }] : [],
    logoUploadId: i % 2 === 0 ? `mockLogo${String(i).padStart(16, '0')}` : undefined,
    history: [
      ev('created', createdAt, null, `客户提交询盘（${(['WIZARD', 'FORM', 'CART', 'CUSTOMIZER', 'SAMPLE'] as const)[i % 5]}）`),
      ev('inbound', createdAt, null, '收到客户来信：首次询盘'),
      ...(assignee ? [ev('assignment', ago(8 + i * 350), ADMIN, `分配给 ${assignee.name}`)] : []),
      ...(status !== 'NEW' ? [ev('reply', ago(5 + i * 300), assignee ? { name: assignee.name, role: assignee.role } : null, '已回复客户：Re: Quote')] : []),
      // 第 2 条示例询盘有 14 条状态往返，用来看「加载更早记录（剩 N 条）」
      ...(i === 1 ? Array.from({ length: 14 }, (_, k) => ev('status', ago(6 + k * 3), ADMIN, k % 2 ? '状态：新询盘 → 跟进中' : '状态：跟进中 → 新询盘')) : [])
    ]
  };
}

/** 已匿名化示例（保留期到期 cron 处理后的样子）：PII 为 [deleted] / 空，邮箱为 deleted+随机@invalid.invalid */
function makeAnonymized(): Row {
  const base = make(23);
  return {
    ...base, id: 'inq_anon_1', status: 'WON', assignee: users[0], createdAt: ago(60 * 24 * 760), anonymizedAt: ago(60 * 24 * 30),
    contact: { name: '[deleted]', email: 'deleted+k3j9q2x7@invalid.invalid', company: '[deleted]', phone: undefined, region: 'DE' }, ipCountry: null,
    message: undefined, attribution: undefined, trustReasons: [], logoUploadId: undefined, attachments: [], notes: [{ id: 'n1', author: '业务员 A', body: '[deleted]', createdAt: ago(60 * 24 * 700) }],
    messages: [{ id: 'm1', direction: 'INBOUND', subject: '[deleted]', bodyHtml: '[deleted]', createdAt: ago(60 * 24 * 760) }],
    history: [ev('created', ago(60 * 24 * 760), null, '客户提交询盘（FORM）'), ev('inbound', ago(60 * 24 * 760), null, '收到客户来信：[deleted]')],
  };
}
const db: Row[] = [...Array.from({ length: 23 }, (_, i) => make(i)), makeAnonymized()];
const summary = ({ id, ref, status, source, locale, contact, products, trustScore, assignee, createdAt, anonymizedAt }: Row): InquirySummary =>
  ({ id, ref, status, source, locale, contact: { name: contact.name, email: contact.email, company: contact.company, region: contact.region }, products, trustScore, assignee, createdAt, anonymizedAt });
const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 120));

/** 与服务端一致：纯文本全部转义，换行转 <br> */
const textToHtml = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)).join('<br>');

export const mockAdminApi: AdminApi = {
  async listInquiries(q) {
    let rows = db.slice();
    if (!q.includeAnonymized) rows = rows.filter((r) => !r.anonymizedAt); // 与后端 includeAnonymized 默认 false 一致
    if (q.status === 'REVIEW') rows = rows.filter((r) => !r.anonymizedAt && r.trustScore < REVIEW_THRESHOLD);
    else if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter((r) => [r.ref, r.contact.email, r.contact.company ?? '', r.contact.name].some((v) => v.toLowerCase().includes(s))); }
    if (q.from) rows = rows.filter((r) => r.createdAt >= q.from!);
    if (q.to) rows = rows.filter((r) => r.createdAt <= q.to! + 'T23:59:59Z');
    if (q.product) rows = rows.filter((r) => r.products.some((p) => p.productSlug === q.product));
    if (q.minScore != null) rows = rows.filter((r) => r.trustScore >= q.minScore!);
    if (q.maxScore != null) rows = rows.filter((r) => r.trustScore <= q.maxScore!);
    if (q.assignee === 'me') rows = rows.filter((r) => r.assignee?.id === 'u1');
    else if (q.assignee === 'none') rows = rows.filter((r) => !r.assignee);
    else if (q.assignee) rows = rows.filter((r) => r.assignee?.id === q.assignee);
    const pageSize = q.pageSize ?? 10, page = Math.max(1, q.page ?? 1);
    return delay({ items: rows.slice((page - 1) * pageSize, page * pageSize).map(summary), total: rows.length, page, pageSize });
  },
  async getInquiry(id) {
    const r = db.find((x) => x.id === id);
    if (!r) return delay(null);
    const { history: _h, ...detail } = r; void _h;
    return delay<InquiryDetail>(detail);
  },
  async updateInquiry(id, patch) {
    const r = db.find((x) => x.id === id); if (!r) throw new Error('not_found'); if (r.anonymizedAt) throw new Error('anonymized');
    if (patch.status && patch.status !== r.status) { r.history.push(ev('status', new Date().toISOString(), ME, `状态：${STATUS_LABEL[r.status]} → ${STATUS_LABEL[patch.status]}`)); r.status = patch.status; }
    if (patch.assigneeId !== undefined && (patch.assigneeId ?? undefined) !== r.assignee?.id) { r.assignee = users.find((u) => u.id === patch.assigneeId); r.history.push(ev('assignment', new Date().toISOString(), ME, r.assignee ? `分配给 ${r.assignee.name}` : '取消分配')); }
    return delay({ id: r.id, status: r.status, assigneeId: r.assignee?.id ?? null, updatedAt: new Date().toISOString() });
  },
  async reply(id, { subject, body }) {
    const r = db.find((x) => x.id === id); if (!r) throw new Error('not_found'); if (r.anonymizedAt) throw new Error('anonymized');
    const m = { id: `m${Date.now()}`, direction: 'OUTBOUND' as const, subject, bodyHtml: textToHtml(body), author: '我', createdAt: new Date().toISOString() };
    r.messages.push(m); r.history.push(ev('reply', m.createdAt, ME, `已回复客户：${subject.slice(0, 80)}`));
    return delay(m);
  },
  async addNote(id, body) {
    const r = db.find((x) => x.id === id); if (!r) throw new Error('not_found'); if (r.anonymizedAt) throw new Error('anonymized');
    const n = { id: `n${Date.now()}`, author: '我', body, createdAt: new Date().toISOString() };
    r.notes.push(n); return delay(n);
  },
  async listUsers() { const res: AdminUsersResponse = { items: users }; return usersFromResponse(await delay(res)); },
  // 与真实接口一致：新的在前；before = 上一页最后一条的 cursor；不认识的游标 → bad_cursor；不存在 → not_found
  async getHistory(id, q = {}) {
    const r = db.find((x) => x.id === id); if (!r) throw new Error('not_found');
    const all = r.history.slice().sort((a, b) => b.at.localeCompare(a.at) || b.cursor.localeCompare(a.cursor, 'en', { numeric: true }));
    let start = 0;
    if (q.before) { start = all.findIndex((x) => x.cursor === q.before) + 1; if (start === 0) throw new Error('bad_cursor'); }
    const limit = Math.min(HISTORY_MAX_LIMIT, Math.max(1, q.limit ?? HISTORY_PAGE_SIZE));
    return historyPageFrom(await delay({ items: all.slice(start, start + limit), total: all.length }));
  },
  async logoPreview() {
    // 示例 Logo（SVG data URL），真实接口返回重新编码后的 PNG
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" rx="12" fill="#fff"/><circle cx="50" cy="50" r="28" fill="#D4AF6A"/><text x="90" y="60" font-family="Arial" font-size="26" font-weight="700" fill="#1C1C1C">ACME</text></svg>';
    return delay(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  }
};
