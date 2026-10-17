import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import { AwsClient } from 'aws4fetch';
import { isProdEnvFrom } from '../site';

/**
 * 私有文件存储抽象。key 只由服务端生成，且必须通过 KEY_RE 校验。
 * - STORAGE_DRIVER=local（开发默认；自建生产可用）：本地目录 UPLOAD_DIR（开发默认 ./storage/uploads；生产必须是挂载数据卷的绝对路径），不在 public/ 下
 * - STORAGE_DRIVER=r2：Cloudflare R2（S3 API，SigV4 签名）。桶必须是私有的，文件只经后端接口按权限提供，不生成公开地址
 */
export interface PrivateStorage {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[A-Za-z0-9/_-]+\.(png|webp|glb)$/;
export function assertKey(key: string) {
  if (typeof key !== 'string' || key.includes('\0') || !KEY_RE.test(key) || key.includes('..') || key.startsWith('/') || key.includes('//')) throw new Error('bad storage key');
  return key;
}

export type StoredType = 'png' | 'webp' | 'glb';
/** 按文件头（magic bytes）识别实际类型，不看文件名和客户端声明的 Content-Type */
export function detectStoredType(b: Buffer): StoredType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2) return 'glb';
  return null;
}
/** key 的扩展名必须与文件头识别出的类型一致（扩展名由检测到的类型决定，而不是用户的文件名） */
export function assertContentMatchesKey(key: string, data: Buffer) {
  const ext = assertKey(key).slice(key.lastIndexOf('.') + 1);
  if (detectStoredType(data) !== ext) throw new Error('storage content does not match key type');
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/**
 * #323：本地驱动单个文件读取上限。写入路径的上限远小于它（logo ≤ 2MB 重编码成 PNG，模型上传整个请求 ≤ 4MB），
 * 超过就说明文件不是经接口写入的（被替换或损坏），直接报错（接口返回 500），不读进内存。
 */
export const STORAGE_READ_MAX_BYTES = 8 * 1024 * 1024;
const badKey = () => new Error('bad storage key');
const tooLarge = () => new Error('storage object too large');
const isErr = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? '');

/**
 * 本地磁盘（自建服务器上挂载的数据卷，STORAGE_DRIVER=local + UPLOAD_DIR）。
 * - 只写在 UPLOAD_DIR 下：key 先过 assertKey（服务端生成的随机 id，只允许 png/webp/glb），再 path.resolve + 前缀检查；
 * - 不跟随符号链接：根目录取 realpath，中间目录逐级 lstat，不是真实目录（含符号链接）一律拒绝；文件用 O_NOFOLLOW 打开，读之前 fstat 确认是普通文件、不超过 STORAGE_READ_MAX_BYTES；
 * - 写入 O_EXCL（不覆盖）、文件 0600、目录 0700；写入前校验文件头与扩展名一致；
 * - 这个目录从不被静态服务（不在 public/ 下，prod-env-check 也拒绝 public/、.next/ 下的目录），文件只经现有接口按原有权限和响应头提供。
 */
export class LocalStorage implements PrivateStorage {
  private root: string;
  private maxReadBytes: number;
  constructor(root: string, opts: { maxReadBytes?: number } = {}) { this.root = path.resolve(root); this.maxReadBytes = opts.maxReadBytes ?? STORAGE_READ_MAX_BYTES; }

  /** 返回 key 对应的绝对路径（保证在真实根目录内、中间目录都是真实目录）；create=false 且目录不存在时返回 null */
  private async target(key: string, create: boolean): Promise<string | null> {
    const k = assertKey(key);
    if (create) await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    let realRoot: string;
    try { realRoot = await fs.realpath(this.root); } catch (e) { if (!create && isErr(e, 'ENOENT')) return null; throw e; }
    const p = path.resolve(realRoot, k);
    if (!p.startsWith(realRoot + path.sep)) throw badKey();
    let dir = realRoot;
    for (const seg of path.relative(realRoot, path.dirname(p)).split(path.sep).filter(Boolean)) {
      dir = path.join(dir, seg);
      if (create) { try { await fs.mkdir(dir, { mode: 0o700 }); } catch (e) { if (!isErr(e, 'EEXIST')) throw e; } }
      let st;
      try { st = await fs.lstat(dir); } catch (e) { if (!create && isErr(e, 'ENOENT')) return null; throw e; }
      if (st.isSymbolicLink() || !st.isDirectory()) throw badKey();
    }
    return p;
  }

  async put(key: string, data: Buffer) {
    assertContentMatchesKey(key, data);
    const p = (await this.target(key, true))!;
    const fh = await fs.open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    try { await fh.writeFile(data); } catch (e) {
      await fh.close().catch(() => {});
      await fs.unlink(p).catch(() => {});
      throw e;
    }
    await fh.close();
  }

  async get(key: string) {
    const p = await this.target(key, false);
    if (!p) return null;
    let fh;
    try { fh = await fs.open(p, fsConstants.O_RDONLY | O_NOFOLLOW); } catch (e) {
      if (isErr(e, 'ENOENT')) return null;
      if (isErr(e, 'ELOOP', 'EMLINK')) throw badKey(); // 最后一段是符号链接
      throw e;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw badKey();
      // #323：读之前按 fstat 的大小拒绝超大文件（不把它整个读进内存）；读完再查一次，防止读的过程中文件变大
      if (st.size > this.maxReadBytes) throw tooLarge();
      const data = await fh.readFile();
      if (data.length > this.maxReadBytes) throw tooLarge();
      return data;
    } finally { await fh.close(); }
  }

  async delete(key: string) {
    const p = await this.target(key, false);
    if (!p) return;
    // unlink 删除的是目录项本身，不会跟随符号链接去删根目录以外的文件
    try { await fs.unlink(p); } catch (e) { if (!isErr(e, 'ENOENT')) throw e; }
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
  const driver = env.STORAGE_DRIVER?.trim() || 'local';
  if (driver === 'local') {
    const dir = env.UPLOAD_DIR?.trim();
    // 生产（APP_ENV=production）必须显式给绝对路径，不回落到 cwd 下的默认目录；启动时 prod-env-check 还会检查目录存在且可写
    if (isProdEnvFrom(env) && (!dir || !path.isAbsolute(dir))) throw new Error('STORAGE_DRIVER=local 在生产环境需要绝对路径的 UPLOAD_DIR');
    return new LocalStorage(dir || path.join(process.cwd(), 'storage', 'uploads'));
  }
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
