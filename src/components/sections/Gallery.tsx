'use client';
import { useRef, useState } from 'react';
import { ImagePlaceholder } from './ui';

// 详情页主图 + 缩略图（§8.2）：左右键切换，选中 2px --accent-text 外框
export type Shot = { path: string; src?: string; alt?: string };
export default function Gallery({ shots, label }: { shots: Shot[]; label: string }) {
  const [i, setI] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!shots.length) return null;
  const go = (n: number) => { const k = (n + shots.length) % shots.length; setI(k); refs.current[k]?.focus(); };
  return (
    <div className="sx-gallery">
      <ImagePlaceholder {...shots[i]} />
      {shots.length > 1 && (
        <div className="sx-thumbs" role="group" aria-label={label}>
          {shots.map((s, k) => (
            <button key={s.path + k} ref={(el) => { refs.current[k] = el; }} type="button" className="sx-thumb" aria-pressed={k === i} aria-label={`${k + 1} / ${shots.length}`}
              tabIndex={k === i ? 0 : -1} onClick={() => setI(k)}
              onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); go(k + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); go(k - 1); } }}>
              <ImagePlaceholder path="" src={s.src} ratio="1 / 1" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
