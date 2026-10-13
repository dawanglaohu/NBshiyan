import type { ModelApi } from './models';
import { mockModelApi } from './models-mock';
import { httpModelApi } from './models-http';
/** 与询盘一致：NEXT_PUBLIC_ADMIN_API=http 时走真实接口 */
export const modelApi: ModelApi = process.env.NEXT_PUBLIC_ADMIN_API === 'http' ? httpModelApi : mockModelApi;
export * from './models';
