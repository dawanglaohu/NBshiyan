import { promises as fs } from 'fs';
import path from 'path';

/**
 * 私有文件存储抽象。现在用本地目录（不在 public/ 下，不会被静态服务），
 * 上线后实现同样接口的 R2 版本替换即可。key 只由服务端生成。
 */
export interface PrivateStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[A-Za-z0-9/_-]+\.(png|webp|glb)$/;

class LocalStorage implements PrivateStorage {
  constructor(private root: string) {}
  private resolve(key: string) {
    if (!KEY_RE.test(key) || key.includes('..')) throw new Error('bad storage key');
    const p = path.resolve(this.root, key);
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

export const storage: PrivateStorage = new LocalStorage(
  path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'storage', 'uploads')),
);
