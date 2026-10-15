import type { AdminApi, AdminUser, AdminUsersResponse, InquiryDetail, InquiryStatus, InquirySummary } from './types';
import { REVIEW_THRESHOLD, STATUS_LABEL, usersFromResponse } from './types';

// 示例数据，仅用于后台页面开发；接入真实接口后不再使用
const users: AdminUser[] = [{ id: 'u1', name: '业务员 A', email: 'sales-a@packjoyu.example', role: 'SALES' }, { id: 'u2', name: '业务员 B', email: 'sales-b@packjoyu.example', role: 'SALES' }];
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const PRODUCTS = ['wine-boxes', 'paper-cups', 'corrugated-boxes', 'gift-boxes', 'molded-pulp', 'color-boxes'];
const COMPANIES: [string, string, string][] = [
  ['Acme GmbH', 'DE', 'anna@acme.de'], ['ООО Ромашка', 'RU', 'ivan@romashka.ru'], ['', 'US', 'buyer123@gmail.com'],
  ['Bloom Co', 'AU', 'sam@bloom.co'], ['Nordic Tea AB', 'SE', 'lena@nordictea.se'], ['Maison Vin', 'FR', 'paul@maisonvin.fr']
];
const STATUSES: InquiryStatus[] = ['NEW', 'FOLLOWING', 'NEW', 'QUOTED', 'WON', 'INVALID'];

function make(i: number): InquiryDetail {
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
      { id: 'h1', at: createdAt, action: '询盘创建' },
      ...(assignee ? [{ id: 'h2', at: ago(8 + i * 350), actor: '管理员', action: `分配给 ${assignee.name}` }] : [])
    ]
  };
}

/** 已匿名化示例（保留期到期 cron 处理后的样子）：PII 为 [deleted] / 空，邮箱为 deleted+随机@invalid.invalid */
function makeAnonymized(): InquiryDetail {
  const base = make(23);
  return {
    ...base, id: 'inq_anon_1', status: 'WON', assignee: users[0], createdAt: ago(60 * 24 * 760), anonymizedAt: ago(60 * 24 * 30),
    contact: { name: '[deleted]', email: 'deleted+k3j9q2x7@invalid.invalid', company: '[deleted]', phone: undefined, region: 'DE' }, ipCountry: null,
    message: undefined, attribution: undefined, trustReasons: [], logoUploadId: undefined, attachments: [], notes: [{ id: 'n1', author: '业务员 A', body: '[deleted]', createdAt: ago(60 * 24 * 700) }],
    messages: [{ id: 'm1', direction: 'INBOUND', subject: '[deleted]', bodyHtml: '[deleted]', createdAt: ago(60 * 24 * 760) }],
    history: [{ id: 'h1', at: ago(60 * 24 * 760), action: '询盘创建' }, { id: 'h2', at: ago(60 * 24 * 30), actor: '系统', action: '按数据保留政策匿名化' }],
  };
}
const db: InquiryDetail[] = [...Array.from({ length: 23 }, (_, i) => make(i)), makeAnonymized()];
const summary = ({ id, ref, status, source, locale, contact, products, trustScore, assignee, createdAt, anonymizedAt }: InquiryDetail): InquirySummary =>
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
  async getInquiry(id) { return delay(db.find((r) => r.id === id) ?? null); },
  async updateInquiry(id, patch) {
    const r = db.find((x) => x.id === id); if (!r) throw new Error('not_found'); if (r.anonymizedAt) throw new Error('anonymized');
    if (patch.status && patch.status !== r.status) { r.history.push({ id: `h${Date.now()}`, at: new Date().toISOString(), actor: '我', action: `状态改为「${STATUS_LABEL[patch.status]}」` }); r.status = patch.status; }
    if (patch.assigneeId !== undefined) { r.assignee = users.find((u) => u.id === patch.assigneeId); r.history.push({ id: `h${Date.now()}a`, at: new Date().toISOString(), actor: '我', action: r.assignee ? `分配给 ${r.assignee.name}` : '取消分配' }); }
    return delay({ id: r.id, status: r.status, assigneeId: r.assignee?.id ?? null, updatedAt: new Date().toISOString() });
  },
  async reply(id, { subject, body }) {
    const r = db.find((x) => x.id === id); if (!r) throw new Error('not_found'); if (r.anonymizedAt) throw new Error('anonymized');
    const m = { id: `m${Date.now()}`, direction: 'OUTBOUND' as const, subject, bodyHtml: textToHtml(body), author: '我', createdAt: new Date().toISOString() };
    r.messages.push(m); r.history.push({ id: `h${Date.now()}r`, at: m.createdAt, actor: '我', action: '发送回复' });
    return delay(m);
  },
  async addNote(id, body) {
    const r = db.find((x) => x.id === id); if (!r) throw new Error('not_found'); if (r.anonymizedAt) throw new Error('anonymized');
    const n = { id: `n${Date.now()}`, author: '我', body, createdAt: new Date().toISOString() };
    r.notes.push(n); return delay(n);
  },
  async listUsers() { const res: AdminUsersResponse = { items: users }; return usersFromResponse(await delay(res)); },
  async logoPreview() {
    // 示例 Logo（SVG data URL），真实接口返回重新编码后的 PNG
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" rx="12" fill="#fff"/><circle cx="50" cy="50" r="28" fill="#D4AF6A"/><text x="90" y="60" font-family="Arial" font-size="26" font-weight="700" fill="#1C1C1C">ACME</text></svg>';
    return delay(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  }
};
