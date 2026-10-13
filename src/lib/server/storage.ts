import { promises as fs } from 'fs';
import path from 'path';
import { AwsClient } from 'aws4fetch';

/**
 * 私有文件存储抽象。key 只由服务端生成，且必须通过 KEY_RE 校验。
 * - STORAGE_DRIVER=local（默认）：本地目录 UPLOAD_DIR（默认 ./storage/uploads），不在 public/ 下
 * - STORAGE_DRIVER=r2：Cloudflare R2（S3 API，SigV4 签名）。桶必须是私有的，文件只经后端接口按权限提供，不生成公开地址
 */
export interface PrivateStorage {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[A-Za-z0-9/_-]+\.(png|webp|glb)$/;
export function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes('..') || key.startsWith('/') || key.includes('//')) throw new Error('bad storage key');
  return key;
}

export class LocalStorage implements PrivateStorage {
  private root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private resolve(key: string) {
    const p = path.resolve(this.root, assertKey(key));
    if (!p.startsWith(this.root + path.sep)) throw new Error('bad storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await fs.writeFile(p, data, { mode: 0o600, flag: 'wx' });
  }
  async get(key: string) {
    try { return await fs.readFile(this.resolve(key)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(key: string) {
    try { await fs.unlink(this.resolve(key)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

export type R2Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; timeoutMs?: number };

/** R2 / 任意 S3 兼容存储，path-style：{endpoint}/{bucket}/{key} */
export class S3Storage implements PrivateStorage {
  private client: AwsClient;
  private base: string;
  private timeoutMs: number;
  constructor(cfg: R2Config) {
    this.client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto', retries: 2, initRetryMs: 100 });
    this.base = `${cfg.endpoint.replace(/\/$/, '')}/${encodeURIComponent(cfg.bucket)}/`;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }
  private url(key: string) { return this.base + assertKey(key).split('/').map(encodeURIComponent).join('/'); }
  async put(key: string, data: Buffer, contentType = 'application/octet-stream') {
    const r = await this.client.fetch(this.url(key), {
      method: 'PUT', body: new Uint8Array(data),
      headers: { 'Content-Type': contentType, 'If-None-Match': '*' }, // 不覆盖已存在的对象（与本地 wx 一致）
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) throw new Error(`storage put ${r.status}`);
  }
  async get(key: string) {
    const r = await this.client.fetch(this.url(key), { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`storage get ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async delete(key: string) {
    const r = await this.client.fetch(this.url(key), { method: 'DELETE', signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok && r.status !== 404) throw new Error(`storage delete ${r.status}`);
  }
}

export function createStorage(env: Record<string, string | undefined> = process.env): PrivateStorage {
  const driver = env.STORAGE_DRIVER ?? 'local';
  if (driver === 'local') return new LocalStorage(env.UPLOAD_DIR ?? path.join(process.cwd(), 'storage', 'uploads'));
  if (driver === 'r2') {
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
    const endpoint = env.R2_ENDPOINT ?? (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) throw new Error('STORAGE_DRIVER=r2 需要 R2_ACCOUNT_ID（或 R2_ENDPOINT）、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_BUCKET');
    if (env.NODE_ENV === 'production' && !endpoint.startsWith('https://')) throw new Error('R2_ENDPOINT 必须是 https');
    return new S3Storage({ endpoint, bucket: R2_BUCKET, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY });
  }
  throw new Error(`未知的 STORAGE_DRIVER: ${driver}`);
}

const g = globalThis as unknown as { __privateStorage?: PrivateStorage };
/** 延迟创建，避免构建期因缺少环境变量报错 */
export const storage: PrivateStorage = {
  put: (k, d, t) => (g.__privateStorage ??= createStorage()).put(k, d, t),
  get: (k) => (g.__privateStorage ??= createStorage()).get(k),
  delete: (k) => (g.__privateStorage ??= createStorage()).delete(k),
};
