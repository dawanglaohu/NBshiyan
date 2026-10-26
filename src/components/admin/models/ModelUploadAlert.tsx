import { FORM_INVALID, outageFormGeneric, outageFormMessage } from '@/lib/admin/outage-copy';
import { ModelApiError } from '@/lib/admin/models';

const GENERIC = outageFormGeneric();
const OUTAGE = outageFormMessage();
const FILE_TOO_LARGE = '文件超过上限（主 GLB ≤1.5MB、高精度层 ≤1MB、封面 ≤512KB）';

/**
 * 已知错误码 → 固定文案。对不上的码和任何 Error.message 都用通用句。
 * 响应没有 error 字段时，客户端把状态码记成 http_413 / http_503。
 * http_413 与单文件 too_large 用同一句；http_503 与 service_unavailable 用停机句。
 */
export const MODEL_UPLOAD_ERRORS: Record<string, string> = {
  too_large: FILE_TOO_LARGE,
  http_413: FILE_TOO_LARGE,
  unsupported_type: '不是有效的 GLB 文件',
  not_ready: '检查未全部通过，不能上架',
  forbidden_origin: '请求被拒绝：来源校验失败，请刷新页面后重试',
  unauthorized: '登录已过期，请重新登录',
  forbidden: '没有权限（需要 ADMIN 或 EDITOR 角色）',
  upload_too_large: '本次上传的文件合计超过 4MB 上限（服务器单个请求不能超过 4MB），请先压缩后再上传',
  length_required: '上传请求缺少大小信息，请刷新页面后重试',
  rate_limited: '操作太频繁，请稍后再试',
  not_found: '这条内容不存在或已被删除，请刷新列表。',
  published: '这个模型已上架，不能直接删除，请先下架再删除。',
  invalid_image: '图片格式不支持或文件已损坏，请换一张再上传。',
  missing_file: '请先选择要上传的文件。',
  invalid: FORM_INVALID.zh,
  account_disabled: '你的账号已被停用，请联系管理员。',
  service_unavailable: OUTAGE,
  http_503: OUTAGE,
};

/** 模型上传失败时页面上显示的句子。不返回 code，也不返回 message。 */
export function modelUploadErrorText(error: unknown): string {
  if (error instanceof ModelApiError && Object.prototype.hasOwnProperty.call(MODEL_UPLOAD_ERRORS, error.code)) return MODEL_UPLOAD_ERRORS[error.code];
  return GENERIC;
}

/** 上传页的错误条。text 必须已经是 modelUploadErrorText 或客户端自己的固定句子。 */
export function ModelUploadAlert({ text }: { text: string }) {
  return <p className="warn" role="alert">{text}</p>;
}

/** 检查项 detail。解析失败时服务端给的是固定句，这里原样显示。 */
export function ModelCheckDetail({ detail, warn }: { detail: string; warn?: boolean }) {
  return <span>{detail}{warn ? '（仅提示）' : ''}</span>;
}
