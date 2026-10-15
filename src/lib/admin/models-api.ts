import type { ModelApi } from './models';
import { lazyApi } from './lazyApi';
import { httpModelApi } from './models-http';
/** 与询盘一致：NEXT_PUBLIC_ADMIN_API=http 时走真实接口 */
export const modelApi: ModelApi = process.env.NEXT_PUBLIC_ADMIN_API === 'http' ? httpModelApi
  : lazyApi<ModelApi>(() => import('./models-mock').then((m) => m.mockModelApi));
export * from './models';
