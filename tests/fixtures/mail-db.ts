// #74 测试用内存数据库：只实现邮件后端用到的 Prisma 子集（where 支持 AND/OR/in/not/lt/lte/gt/is、null、Date），唯一约束冲突抛 P2002。
type Row = Record<string, any>;
const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

export function createMailDb(opts: { inquiries?: Row[] } = {}) {
  const inquiries: Row[] = opts.inquiries ?? [];
  const mails: Row[] = [];
  let seq = 0;
  const calls: string[] = [];

  function match(row: Row, where: Row | undefined, table: 'mail' | 'inquiry'): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'AND') { if (!(v as Row[]).every((w) => match(row, w, table))) return false; continue; }
      if (k === 'OR') { if (!(v as Row[]).some((w) => match(row, w, table))) return false; continue; }
      if (k === 'inquiry' && table === 'mail') {
        const inq = inquiries.find((i) => i.id === row.inquiryId);
        if (!inq || !match(inq, (v as Row).is, 'inquiry')) return false; continue;
      }
      const cur = row[k];
      if (v === null) { if (cur != null) return false; continue; }
      if (v instanceof Date || typeof v !== 'object') { if (!eq(cur, v)) return false; continue; }
      const o = v as Row;
      if ('in' in o && !(o.in as unknown[]).some((x) => eq(cur, x))) return false;
      if ('not' in o && (o.not === null ? cur == null : eq(cur, o.not))) return false;
      if ('lt' in o && !(cur != null && cur < o.lt)) return false;
      if ('lte' in o && !(cur != null && cur <= o.lte)) return false;
      if ('gt' in o && !(cur != null && cur > o.gt)) return false;
    }
    return true;
  }
  function apply(row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
    row.updatedAt = new Date();
  }
  const UNIQUE = ['messageId', 'sendKey', 'remoteMailId', 'idemKey'];
  function checkUnique(row: Row, self?: Row) {
    for (const k of UNIQUE) if (row[k] != null && mails.some((m) => m !== self && m[k] === row[k])) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
  }
  const pick = (row: Row | undefined, select?: Row) => {
    if (!row) return null;
    if (!select) return { ...row };
    const out: Row = {};
    for (const k of Object.keys(select)) out[k] = row[k];
    return out;
  };

  const mailMessage = {
    async create({ data }: { data: Row }) {
      calls.push('mail.create');
      const row: Row = {
        id: `cmmail${String(++seq).padStart(18, '0')}`, inquiryId: null, messageId: null, sendKey: null, inReplyTo: null, references: null, remoteMailId: null, idemKey: null,
        fromHash: null, hasRemoteImages: false, authSpf: null, authDkim: null, authDmarc: null, senderVerified: null, authorId: null, errorCode: null, retryable: false,
        attempts: 0, retryCount: 0, lockedUntil: null, requestStartedAt: null, capDay: null, deferredUntil: null, deliveryStatus: 'UNKNOWN', redactedAt: null, flags: [],
        sentAt: null, receivedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data,
      };
      checkUnique(row);
      mails.push(row);
      return { ...row };
    },
    async findUnique({ where, select }: { where: Row; select?: Row }) { return pick(mails.find((m) => match(m, where, 'mail')), select); },
    async findFirst({ where, select, include }: { where: Row; select?: Row; include?: Row }) {
      const r = mails.find((m) => match(m, where, 'mail'));
      if (r && include?.inquiry) return { ...r, inquiry: pick(inquiries.find((i) => i.id === r.inquiryId), include.inquiry.select) };
      return pick(r, select);
    },
    async findMany({ where, take, select }: { where?: Row; take?: number; select?: Row; orderBy?: unknown }) {
      return mails.filter((m) => match(m, where, 'mail')).sort((a, b) => a.createdAt - b.createdAt).slice(0, take ?? 1e9).map((r) => pick(r, select));
    },
    async count({ where }: { where: Row }) { return mails.filter((m) => match(m, where, 'mail')).length; },
    async update({ where, data }: { where: Row; data: Row }) {
      const r = mails.find((m) => match(m, where, 'mail'));
      if (!r) throw Object.assign(new Error('not found'), { code: 'P2025' });
      const next = { ...r }; apply(next, data); checkUnique(next, r); Object.assign(r, next);
      return { ...r };
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const rs = mails.filter((m) => match(m, where, 'mail'));
      for (const r of rs) apply(r, data);
      return { count: rs.length };
    },
    async deleteMany({ where }: { where: Row }) {
      let n = 0;
      for (let i = mails.length - 1; i >= 0; i--) if (match(mails[i], where, 'mail')) { mails.splice(i, 1); n++; }
      return { count: n };
    },
  };
  const inquiry = {
    async findFirst({ where, select }: { where: Row; select?: Row }) {
      const r = inquiries.find((i) => match(i, where, 'inquiry'));
      if (!r) return null;
      if (!select) return { ...r };
      const out: Row = {};
      for (const [k, v] of Object.entries(select)) out[k] = k === 'contact' && v && typeof v === 'object' ? pick(r.contact, (v as Row).select) : r[k];
      return out;
    },
    async updateMany({ where, data }: { where: Row; data: Row }) {
      const rs = inquiries.filter((i) => match(i, where, 'inquiry'));
      for (const r of rs) Object.assign(r, data);
      return { count: rs.length };
    },
  };
  // 串行化事务：模拟 advisory lock（同一时间只有一个事务在跑）
  let chain: Promise<unknown> = Promise.resolve();
  const db: Row = {
    mailMessage, inquiry,
    async $queryRawUnsafe(sql: string) { calls.push(sql.includes('pg_advisory_xact_lock') ? 'advisory_lock' : 'raw'); return [{ ok: '' }]; },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      const run = chain.then(() => fn(db));
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { db, mails, inquiries, calls };
}
