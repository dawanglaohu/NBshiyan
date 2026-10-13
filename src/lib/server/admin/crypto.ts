import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { hash, verify } from '@node-rs/argon2';

// argon2id 参数（OWASP 推荐下限之上）
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashSecret = (s: string) => hash(s, ARGON);
export const verifySecret = async (h: string, s: string) => { try { return await verify(h, s); } catch { return false; } };
// 用户不存在时也做一次同样耗时的校验，避免通过响应时间探测邮箱
let dummy: Promise<string> | null = null;
export const burnVerify = async (s: string) => { dummy ??= hashSecret('dummy-password-for-timing'); await verifySecret(await dummy, s); };

function key() {
  const k = Buffer.from(process.env.ADMIN_TOTP_KEY ?? '', 'base64');
  if (k.length !== 32) throw new Error('ADMIN_TOTP_KEY 必须是 32 字节 base64');
  return k;
}
/** AES-256-GCM，格式 v1.iv.tag.ciphertext（base64url） */
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}
export function decrypt(enc: string) {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1') throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
