import { outageFormGeneric } from '@/lib/admin/outage-copy';
import { ModelApiError } from '@/lib/admin/models';

const GENERIC = outageFormGeneric();

/** 已知错误码 → 固定文案。对不上的码和任何 Error.message 都用通用句。 */
const API_ERR: Record<string, string> = {
  too_large: '文件超过上限（主 GLB ≤1.5MB、高精度层 ≤1MB、封面 ≤512KB）',
  unsupported_type: '不是有效的 GLB 文件',
  not_ready: '检查未全部通过，不能上架',
  forbidden_origin: '请求被拒绝：来源校验失败，请刷新页面后重试',
  unauthorized: '登录已过期，请重新登录',
  forbidden: '没有权限（需要 ADMIN 或 EDITOR 角色）',
  upload_too_large: '本次上传的文件合计超过 4MB 上限（服务器单个请求不能超过 4MB），请先压缩后再上传',
  length_required: '上传请求缺少大小信息，请刷新页面后重试',
  rate_limited: '操作太频繁，请稍后再试',
};

/** 模型上传失败时页面上显示的句子。不返回 code，也不返回 message。 */
export function modelUploadErrorText(error: unknown): string {
  if (error instanceof ModelApiError && Object.prototype.hasOwnProperty.call(API_ERR, error.code)) return API_ERR[error.code];
  return GENERIC;
}

/** 上传页的错误条。text 必须已经是 modelUploadErrorText 或客户端自己的固定句子。 */
export function ModelUploadAlert({ text }: { text: string }) {
  return <p className="warn" role="alert">{text}</p>;
}
