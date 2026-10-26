'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '@/components/admin/format';
import { commitAndReveal } from '@/components/admin/reveal-error';
import EnrollLinkPanel from './EnrollLinkPanel';
import { ISSUE_ERROR_TEXT, panelReducer, pickEnrollLink, submitCreate, type PanelState } from '@/lib/admin/enroll-link';
import ConfirmDialog from '@/components/admin/settings/ConfirmDialog';
import AdminTime from '@/components/admin/AdminTime';
import { RESET_2FA_CONFIRM } from '@/lib/admin/enroll';

type Role = 'ADMIN' | 'SALES' | 'EDITOR';
type U = { id: string; email: string; name: string; role: Role; disabled: boolean; totpEnabled: boolean; locked: boolean; createdAt: string; lastLoginAt: string | null };
const ROLES: Role[] = ['ADMIN', 'SALES', 'EDITOR'];
const ERR: Record<string, string> = {
  cannot_modify_self: '不能修改自己的账号（停用、降级请让另一位管理员操作）。',
  last_admin: '至少要保留一个有效的管理员。',
  email_taken: '这个邮箱已经有账号了。',
  weak_password: '初始密码至少 12 位，且不能和邮箱相同。',
  invalid: '输入不正确，请检查。',
  ...ISSUE_ERROR_TEXT, // #347 site_url_invalid：按接口分文案，不显示错误码
};
/** 只查自身属性。未知码和 constructor / toString / __proto__ 走 errorText，最后落到通用句。 */
export function userAdminMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(ERR, code) ? ERR[code] : errorText(code, '操作失败');
}
const msg = userAdminMessage;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/users${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `http_${res.status}`);
  return res.json() as Promise<T>;
}

/** selfId：当前登录管理员的账号 id（页面服务端从会话里取），自己那一行不显示「重置 2FA」（自己走账号设置里的自助重置） */
export default function UsersAdmin({ selfId }: { selfId?: string } = {}) {
  const [items, setItems] = useState<U[]>();
  const [err, setErr] = useState('');
  const errRef = useRef<HTMLParagraphElement>(null);
  const showErr = (code: string) => commitAndReveal(errRef, () => setErr(msg(code)));
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'SALES' as Role, password: '' });
  // #347 新建账号 / 重置 2FA 返回的一次性绑定链接：同一个面板、只在这个 state 里，「我已复制」后置 null；后端没返回链接时什么都不多显示
  const [linkPanel, setLinkPanel] = useState<PanelState>(null);
  // 失败（含 site_url_invalid）时不清表单：填的值和初始密码都保留
  const create = () => run(() => submitCreate((f) => api<unknown>('', { method: 'POST', body: JSON.stringify(f) }), form, {
    onIssued: (issued) => setLinkPanel((s) => panelReducer(s, { type: 'issued', issued, email: form.email })),
    onCreated: () => setForm({ email: '', name: '', role: 'SALES', password: '' }),
  }));

  const load = useCallback(() => api<{ items: U[] }>('?all=1').then((d) => setItems(d.items)).catch((e: Error) => showErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { showErr((e as Error).message); } finally { setBusy(false); }
  };
  const patch = (id: string, body: Record<string, unknown>) => run(() => api(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) }));
  // #347：重置 2FA。确认文案是后端的 RESET_2FA_CONFIRM；确认框用后台 ConfirmDialog（危险操作、初始焦点在「取消」、Esc 取消）。
  // 返回的一次性链接进同一个面板（pickEnrollLink + panelReducer）；site_url_invalid 时什么都没改，显示 ERR 里的「没有生成绑定链接：…」
  const [resetTarget, setResetTarget] = useState<U | null>(null);
  const reset2fa = (u: U) => {
    setResetTarget(null);
    run(async () => {
      const issued = pickEnrollLink(await api<unknown>(`/${u.id}/reset-2fa`, { method: 'POST' }));
      if (issued) setLinkPanel((s) => panelReducer(s, { type: 'issued', issued, email: u.email }));
    });
  };

  return (
    <>
      <h1>账号权限</h1>
      {err && <p ref={errRef} tabIndex={-1} role="alert" className="adm-msg err">{err}</p>}
      {/* 新建账号和重置 2FA 共用：放在页面顶部，出现时面板自己获得焦点（会滚动到可见） */}
      {linkPanel && <EnrollLinkPanel issued={linkPanel.issued} email={linkPanel.email} onDismiss={() => setLinkPanel((s) => panelReducer(s, { type: 'dismiss' }))} />}
      <form className="adm-card adm-user-form" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <h2>新建账号</h2>
        <label>邮箱 <input type="email" required maxLength={200} autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>{' '}
        <label>姓名 <input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>{' '}
        <label>角色 <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>{' '}
        <label>初始密码 <input type="password" required minLength={12} maxLength={200} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>{' '}
        <button className="adm-btn" disabled={busy}>创建</button>
        <p className="adm-sub">创建后会生成一次性绑定链接，只显示一次。请把初始密码和绑定链接分开私下发给本人，对方打开链接后用邮箱和初始密码绑定 2FA。链接失效或 2FA 被重置时，在这里重新签发。</p>
      </form>
      <div className="adm-table-wrap">
      <table className="adm-card" style={{ width: '100%' }}>
        <thead><tr><th>邮箱</th><th>姓名</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead>
        <tbody>
          {items?.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td><td>{u.name}</td>
              <td><select aria-label={`${u.email} 的角色`} value={u.role} disabled={busy} onChange={(e) => patch(u.id, { role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></td>
              <td>
                {u.disabled ? '已停用' : u.locked ? '已锁定' : !u.totpEnabled ? '待绑定 2FA' : '正常'}
                {!u.disabled && !u.totpEnabled && <><br /><span className="adm-sub">等本人打开绑定链接</span></>}
              </td>
              <td>{u.lastLoginAt ? <AdminTime iso={u.lastLoginAt} /> : '—'}</td>
              <td>
                <button className="adm-btn" disabled={busy} onClick={() => { if (u.disabled || confirm(`停用 ${u.email}？对方会立即退出登录。`)) patch(u.id, { disabled: !u.disabled }); }}>{u.disabled ? '启用' : '停用'}</button>
                {u.locked && <button className="adm-btn" disabled={busy} onClick={() => patch(u.id, { unlock: true })}>解锁</button>}
                {u.id !== selfId && <button className="adm-btn danger adm-row-last" disabled={busy} onClick={() => setResetTarget(u)}>重置 2FA</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {!items && !err && <p>加载中…</p>}
      {resetTarget && (
        <ConfirmDialog title={RESET_2FA_CONFIRM(resetTarget.email)} confirmLabel="重置 2FA" danger onCancel={() => setResetTarget(null)} onConfirm={() => reset2fa(resetTarget)}>{null}</ConfirmDialog>
      )}
    </>
  );
}
