'use client';
import { useLayoutEffect, useRef } from 'react';
import { countChars } from '@/lib/site-settings/about-rules';
import { charCounter } from '@/lib/admin/about-images';

// 样式在 about-images.css（由 AboutImages 引入；这里不引 CSS，单测可以直接渲染）
const oneLine = (v: string) => v.replace(/[\r\n]+/g, ' ');
const noEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault(); };

/**
 * 替代文字 / 说明的输入框：一行纯文本，但显示成 1–4 行自动长高的多行框（UX 同意的偏差 10）。
 * - 支持 field-sizing: content 的浏览器由 CSS 长高；不支持的用 JS 按 scrollHeight 设高度。两种都由 CSS 的 min-height / max-height 卡在 1–4 行，超过 4 行在框内滚动。
 * - 回车不换行；粘贴进来的换行换成空格。
 */
export default function ImageTextField({ id, dir, value, placeholder, max, required, errorId, onChange }: {
  id: string; dir: 'ltr' | 'rtl'; value: string; placeholder: string; max: number; required?: boolean; errorId?: string; onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { autoGrowFallback(ref.current); }, [value]);
  // UX 条件 2：maxLength 硬上限（125 / 80）；剩 ≤ 10 字时右下角「n/上限」。计数区一直在（空的），读屏的 aria-live 才能读到变化；显示时也用 aria-describedby 关联到输入框
  const counter = charCounter(value, max);
  const cntId = `${id}-cnt`;
  const describedBy = [errorId, counter ? cntId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="st-im-fld">
      <textarea ref={ref} id={id} rows={1} dir={dir} value={value} placeholder={placeholder} maxLength={max} aria-required={required || undefined}
        className={counter ? 'has-cnt' : undefined} aria-invalid={errorId ? true : undefined} aria-describedby={describedBy} onKeyDown={noEnter} onChange={(e) => onChange(oneLine(e.target.value))} />
      <span id={cntId} className={`st-im-cnt${counter && countChars(value) >= max ? ' at-max' : ''}`} aria-live="polite">{counter ?? ''}</span>
    </div>
  );
}

/** 不支持 field-sizing 的浏览器：高度 = 内容高度，再由 CSS max-height（4 行）封顶、min-height（1 行）兜底 */
export function autoGrowFallback(el: HTMLTextAreaElement | null): void {
  if (!el || (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'))) return;
  el.style.height = 'auto';
  const cs = getComputedStyle(el);
  const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  el.style.height = `${el.scrollHeight + borders}px`;
}
