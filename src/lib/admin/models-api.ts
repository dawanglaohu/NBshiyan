import { adminMockEnabled } from '../mockFlags';
import type { ModelApi } from './models';
import { mockModelApi } from './models-mock';
import { httpModelApi } from './models-http';
/** 与询盘一致：NEXT_PUBLIC_ADMIN_API=http 时走真实接口 */
export const modelApi: ModelApi = adminMockEnabled() ? mockModelApi : httpModelApi;
export * from './models';
