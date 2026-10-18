'use client';
import { useCallback, useEffect, useState } from 'react';
import { errorText } from '@/components/admin/format';
import AdminTime from '@/components/admin/AdminTime';
import { ENROLL_PAGE } from '@/lib/admin/enroll';

type Role = 'ADMIN' | 'SALES' | 'EDITOR';
type U = { id: string; email: string; name: string; role: Role; disabled: boolean; totpEnabled: boolean; locked: boolean; createdAt: string; lastLoginAt: string | null };
const ROLES: Role[] = ['ADMIN', 'SALES', 'EDITOR'];
const ERR: Record<string, string> = {
  cannot_modify_self: '不能修改自己的账号（停用、降级请让另一位管理员操作）。',
  last_admin: '至少要保留一个有效的管理员。',
  email_taken: '这个邮箱已经有账号了。',
  weak_password: '初始密码至少 12 位，且不能和邮箱相同。',
  invalid: '输入不正确，请检查。',
};
const msg = (code: string) => ERR[code] ?? errorText(code, '操作失败');

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/users${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `http_${res.status}`);
  return res.json() as Promise<T>;
}

export default function UsersAdmin() {
  const [items, setItems] = useState<U[]>();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'SALES' as Role, password: '' });

  const load = useCallback(() => api<{ items: U[] }>('?all=1').then((d) => setItems(d.items)).catch((e: Error) => setErr(msg(e.message))), []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(msg((e as Error).message)); } finally { setBusy(false); }
  };
  const patch = (id: string, body: Record<string, unknown>) => run(() => api(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) }));

  return (
    <>
      <h1>账号权限</h1>
      {err && <p role="alert" className="adm-msg">{err}</p>}
      <form className="adm-card" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('', { method: 'POST', body: JSON.stringify(form) }); setForm({ email: '', name: '', role: 'SALES', password: '' }); }); }}>
        <h2>新建账号</h2>
        <label>邮箱 <input type="email" required maxLength={200} autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>{' '}
        <label>姓名 <input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>{' '}
        <label>角色 <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>{' '}
        <label>初始密码 <input type="password" required minLength={12} maxLength={200} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>{' '}
        <button className="adm-btn" disabled={busy}>创建</button>
        <p className="spec-meta">初始密码请通过安全渠道只告知本人；对方首次登录前必须先打开 <a href={ENROLL_PAGE}>{ENROLL_PAGE}</a>，用邮箱和初始密码绑定 2FA，拿到初始密码后请立即绑定。2FA 被重置的账号也在这个页面重新绑定。</p>
      </form>
      <table className="adm-card" style={{ width: '100%' }}>
        <thead><tr><th>邮箱</th><th>姓名</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
        <tbody>
          {items?.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td><td>{u.name}</td>
              <td><select aria-label={`${u.email} 的角色`} value={u.role} disabled={busy} onChange={(e) => patch(u.id, { role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
              <td>
                {u.disabled ? '已停用' : u.locked ? '已锁定' : !u.totpEnabled ? '待绑定 2FA' : '正常'}
                {!u.disabled && !u.totpEnabled && <><br /><a href={ENROLL_PAGE} className="spec-meta" title="把这个链接和初始密码分别发给本人，在该页面绑定身份验证器 App 后才能登录">绑定页：{ENROLL_PAGE}</a></>}
              </td>
              <td>{u.lastLoginAt ? <AdminTime iso={u.lastLoginAt} /> : '—'}</td>
              <td>
                <button className="adm-btn" disabled={busy} onClick={() => { if (u.disabled || confirm(`停用 ${u.email}？对方会立即退出登录。`)) patch(u.id, { disabled: !u.disabled }); }}>{u.disabled ? '启用' : '停用'}</button>
                {u.locked && <button className="adm-btn" disabled={busy} onClick={() => patch(u.id, { unlock: true })}>解锁</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items && !err && <p>加载中…</p>}
    </>
  );
}
