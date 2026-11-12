'use client';

import { useEffect, useId, useRef, useState } from 'react';
import SettingsSections from '@/components/admin/settings/SettingsSections';
import '@/components/admin/settings/settings.css';
import {
  getAnalyticsSettings,
  patchAnalyticsSettings,
  type AnalyticsSettingsResult,
  type AnalyticsSettingsUpdateResult,
} from '@/lib/client/ops';
import type { AnalyticsSettingsDTO } from '@/lib/contracts/analytics';

type Notice = { kind: 'ok' | 'err'; text: string } | null;

/** 可注入的请求面：e2e/单测可以在不发 HTTP 的情况下驱动同一状态机。 */
export type AnalyticsSettingsApi = {
  load: (options?: { signal?: AbortSignal }) => Promise<AnalyticsSettingsResult>;
  save: (
    input: { timezone: string; expectedVersion: number },
    options?: { signal?: AbortSignal },
  ) => Promise<AnalyticsSettingsUpdateResult>;
};

const defaultApi: AnalyticsSettingsApi = {
  load: (options) => getAnalyticsSettings(options),
  save: (input, options) => patchAnalyticsSettings(input, options),
};

const IANA_HINT = '例如 Asia/Shanghai、Europe/Moscow、UTC；必须是不存在的 IANA 名称才报错。';

/** 本地只做“明显不是 IANA 名称”的预检；权威校验仍是服务端 TimezoneSchema。 */
export function ianaError(value: string): string | undefined {
  const tz = value.trim();
  if (!tz) return '请填写 IANA 时区。';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return undefined;
  } catch {
    return `这不是有效的 IANA 时区。${IANA_HINT}`;
  }
}

function utcText(iso: string | null): string {
  if (!iso) return '无可用重算待办（null 不表示重建已完成）';
  const d = new Date(iso);
  return `partial：仅 ${Number.isNaN(d.getTime()) ? iso : d.toISOString()} 起可重算；更早历史保留原时区标签`;
}

/**
 * /admin/settings 的「统计时区」分区（M5-T10，11-UI:25）。
 *
 * 布局：左侧表单（IANA 输入 + 保存/撤销），右侧旁栏显示服务端当前 version/timezoneRevision/
 * recomputableFrom；409 只提示并由用户显式「读取最新」，保存停用但输入保留。页面不读浏览器
 * 时区，展示值全部来自 GET/PATCH 响应——两个不同浏览器时区的会话看到同一站点设置。
 */
export default function AnalyticsSettingsContainer({ api = defaultApi }: { api?: AnalyticsSettingsApi }) {
  const [saved, setSaved] = useState<AnalyticsSettingsDTO | null>(null);
  const [timezone, setTimezone] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [fieldErr, setFieldErr] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [rebuildScheduled, setRebuildScheduled] = useState(false);
  const errId = useId();
  const hintId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const errRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .load({ signal: controller.signal })
      .then((r) => {
        if (r.ok) {
          setSaved(r.data);
          setTimezone(r.data.timezone);
          setLoadErr(null);
        } else if (r.action !== 'login') {
          setLoadErr(r.text || '读取站点时区失败。');
        }
      })
      .catch(() => setLoadErr('读取站点时区失败。'));
    return () => controller.abort();
  }, [api]);

  const dirty = saved !== null && timezone.trim() !== saved.timezone;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // 成功/失败提示出现时把状态区滚进视野（键盘/读屏也读得到）
  useEffect(() => {
    const el = notice?.kind === 'err' ? errRef.current : statusRef.current;
    el?.scrollIntoView({ block: 'nearest' });
  }, [notice]);

  const reload = async () => {
    setBusy(true);
    const r = await api.load({});
    setBusy(false);
    if (r.ok) {
      setSaved(r.data);
      setConflict(false);
      setNotice({ kind: 'ok', text: `已读取最新配置（version ${r.data.version}）；你的输入保留。` });
      return;
    }
    setNotice({ kind: 'err', text: r.text || '读取最新配置失败。' });
  };

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!saved || busy || conflict) return;
    const err = ianaError(timezone);
    if (err) {
      setFieldErr(err);
      setNotice(null);
      return;
    }
    setBusy(true);
    setNotice(null);
    setFieldErr(undefined);
    const r = await api.save({ timezone: timezone.trim(), expectedVersion: saved.version });
    setBusy(false);
    if (r.ok) {
      setSaved(r.data);
      setTimezone(r.data.timezone);
      setRebuildScheduled(r.data.rebuildScheduled);
      setNotice({
        kind: 'ok',
        text: `✓ 已保存：version ${r.data.version} · revision ${r.data.timezoneRevision}${r.data.rebuildScheduled ? ' · 已登记重算' : ''}`,
      });
      return;
    }
    if (r.code === 'version_conflict') {
      setConflict(true);
      setNotice({ kind: 'err', text: '配置已被其他会话修改：输入保留、保存已停用；请先读取最新配置。' });
      return;
    }
    if (r.code === 'invalid' && r.fieldErrors?.timezone) {
      setFieldErr(r.fieldErrors.timezone);
      return;
    }
    setNotice({ kind: 'err', text: r.text || '保存失败，请稍后再试。' });
  };

  const discard = () => {
    if (!saved) return;
    setTimezone(saved.timezone);
    setFieldErr(undefined);
    setRebuildScheduled(false);
    setNotice(null);
  };

  if (!saved) {
    return (
      <div className="st-page">
        <SettingsSections current="analytics" />
        <h1>统计时区</h1>
        {loadErr ? (
          <p className="st-ferr" role="alert">
            {loadErr}{' '}
            <button type="button" className="adm-btn" onClick={reload} disabled={busy}>
              重试
            </button>
          </p>
        ) : (
          <p className="st-hint">加载中…</p>
        )}
      </div>
    );
  }

  const errText = fieldErr;
  return (
    <div className="st-page">
      <SettingsSections current="analytics" />
      <h1>统计时区</h1>
      <p className="st-hint">
        这里是全站共用的站点时区，与打开页面的浏览器时区无关；保存后服务端登记重算，只对仍保留原始事件的范围生效。
      </p>
      {notice && notice.kind === 'ok' && (
        <p ref={statusRef} className="st-ok" role="status" data-testid="analytics-settings-status">
          {notice.text}
        </p>
      )}
      {notice && notice.kind === 'err' && (
        <p ref={errRef} className="st-ferr" role="alert" data-testid="analytics-settings-alert">
          {notice.text}{' '}
          {conflict && (
            <button type="button" className="adm-btn" onClick={reload} disabled={busy}>
              读取最新配置
            </button>
          )}
        </p>
      )}

      <div className="st-grid">
        <div className="st-main">
          <section className="adm-card st-card" aria-labelledby="st-tz-h">
            <h2 id="st-tz-h">站点时区</h2>
            <form onSubmit={save} noValidate>
              <div className="st-f">
                <label className="st-lab" htmlFor="st-analytics-tz">
                  <span>IANA 时区</span>
                </label>
                <input
                  id="st-analytics-tz"
                  data-testid="analytics-settings-input"
                  value={timezone}
                  onChange={(e) => {
                    setTimezone(e.target.value);
                    setFieldErr(undefined);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={errText ? true : undefined}
                  aria-describedby={errText ? errId : hintId}
                />
                {errText ? (
                  <p id={errId} className="st-ferr" role="alert" data-testid="analytics-settings-field-error">
                    {errText}
                  </p>
                ) : (
                  <p id={hintId} className="st-hint">
                    {IANA_HINT}
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                <button type="submit" className="adm-btn" data-testid="analytics-settings-save" disabled={!dirty || busy || conflict}>
                  {busy ? '保存中…' : '保存'}
                </button>
                <button type="button" className="adm-btn" onClick={discard} disabled={!dirty || busy}>
                  撤销修改
                </button>
              </div>
            </form>
          </section>
        </div>

        <aside className="st-side">
          <section className="adm-card st-card" aria-labelledby="st-tz-state-h">
            <h2 id="st-tz-state-h">当前状态</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '8px 12px', margin: '0 0 8px' }}>
              <dt style={{ fontWeight: 600 }}>站点时区</dt>
              <dd style={{ margin: 0 }} data-testid="analytics-settings-timezone">{saved.timezone}</dd>
              <dt style={{ fontWeight: 600 }}>配置版本</dt>
              <dd>
                version {saved.version} · revision{' '}
                <span data-testid="analytics-settings-revision">{saved.timezoneRevision}</span>
              </dd>
              <dt style={{ fontWeight: 600 }}>可重算范围</dt>
              <dd style={{ margin: 0 }} data-testid="analytics-settings-recomputable">{utcText(saved.recomputableFrom)}</dd>
            </dl>
            {rebuildScheduled && (
              <p className="st-hint" data-testid="analytics-settings-rebuild">
                本次保存已登记重算。
              </p>
            )}
            <p className="st-hint">版本由服务端递增；冲突时先读取最新值，不自动覆盖你的输入。</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
