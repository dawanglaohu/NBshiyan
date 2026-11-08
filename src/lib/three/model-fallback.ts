import type { ModelFailureReason } from '@/lib/contracts/analytics';

/**
 * 真实模型失败回退的纯规则（M2-T6）。
 * 这里不产生任何分析事件：只把一次加载尝试的结果交给调用方的 `onModelResult`，
 * 统计事件由 M2-T7 在消费方接线。
 */
export type { ModelFailureReason };

export type ModelLoadResult =
  | { slug: string; status: 'ready' }
  | { slug: string; status: 'failed'; reason: ModelFailureReason };

/** 手动重试上限：初始加载之外最多再试 3 次，按钮到上限后禁用，不自动循环。 */
export const MAX_MODEL_RETRIES = 3;

/** 第 attempt 次（0 = 初始加载）是否还允许手动重试。 */
export function retryAllowed(attempt: number): boolean {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < MAX_MODEL_RETRIES;
}

/**
 * 每次重试用不同的 URL 触发真实的新加载：GLTF 缓存按 URL 记账，重复同一 URL 不会再发请求。
 * 只加查询参数，不改路径，渐进式 .lodN.glb 的相对解析不受影响。
 */
export function retrySrc(src: string, attempt: number): string {
  if (attempt <= 0) return src;
  return `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}`;
}

export type FallbackCopy = { failed: string; retry: string; retryLimit: string; webgl: string };

/** 回退文案与 M2-T3 的控件文案同策略：不进 messages/*.json（那些文件被其他 PR 占用）。 */
export function fallbackCopy(locale: string): FallbackCopy {
  if (locale === 'ru') {
    return {
      failed: 'Не удалось показать 3D-модель. Показано фото продукта.',
      retry: 'Повторить',
      retryLimit: 'Попытки исчерпаны',
      webgl: '3D-модель недоступна в этом браузере. Показано фото продукта.',
    };
  }
  return {
    failed: '3D model could not be shown. Showing the product photo.',
    retry: 'Retry',
    retryLimit: 'Retry limit reached',
    webgl: '3D is unavailable in this browser. Showing the product photo.',
  };
}
