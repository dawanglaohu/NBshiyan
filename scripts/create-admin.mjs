// 创建第一个后台管理员。凭据只从环境变量读，不要写进仓库或 shell 历史文件。
// 用法：ADMIN_SEED_EMAIL=... ADMIN_SEED_NAME=... ADMIN_SEED_PASSWORD=... pnpm admin:create
// 创建后需先走 /api/auth-admin/enroll 绑定 2FA 才能登录。
// 仅 CI / 本地：设置 ADMIN_SEED_TOTP_SECRET（base32）会直接写入加密后的 TOTP 密钥并启用 2FA，跳过绑定。
//   生产环境（NODE_ENV=production 或 VERCEL_ENV=production）设置了该变量直接报错退出。
import { createCipheriv, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';

// 拒绝对生产库运行：PROD_DATABASE_HOST 是逗号分隔的生产库主机名（支持 *.example.com 通配），
// DATABASE_URL 的主机命中任意一个就退出。生产库只能走正式流程建号。
export function isProdDatabase(url, patterns) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return (patterns ?? '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean).some((p) =>
    p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p);
}
if (process.env.DATABASE_URL && isProdDatabase(process.env.DATABASE_URL, process.env.PROD_DATABASE_HOST)) {
  console.error('DATABASE_URL 指向生产库（命中 PROD_DATABASE_HOST），seed 脚本拒绝运行'); process.exit(1);
}

const totpSeed = process.env.ADMIN_SEED_TOTP_SECRET?.trim().replace(/\s+/g, '').toUpperCase();
if (totpSeed) {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') {
    console.error('生产环境禁止使用 ADMIN_SEED_TOTP_SECRET，请删掉该变量，改走 2FA 绑定流程'); process.exit(1);
  }
  // base32，至少 16 字符（80 bit）
  if (!/^[A-Z2-7]{16,128}=*$/.test(totpSeed)) { console.error('ADMIN_SEED_TOTP_SECRET 必须是 base32，至少 16 位'); process.exit(1); }
}
/** 与 src/lib/server/admin/crypto.ts 的 encrypt 相同：AES-256-GCM，v1.iv.tag.ciphertext（base64url） */
function encryptTotp(plain) {
  const k = Buffer.from(process.env.ADMIN_TOTP_KEY ?? '', 'base64');
  if (k.length !== 32) { console.error('ADMIN_TOTP_KEY 必须是 32 字节 base64'); process.exit(1); }
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

const email = process.env.ADMIN_SEED_EMAIL?.trim().toLowerCase();
const name = process.env.ADMIN_SEED_NAME?.trim() || 'Admin';
const password = process.env.ADMIN_SEED_PASSWORD;
const role = process.env.ADMIN_SEED_ROLE || 'ADMIN';
if (!email || !password) { console.error('需要 ADMIN_SEED_EMAIL 和 ADMIN_SEED_PASSWORD'); process.exit(1); }
if (password.length < 12) { console.error('密码至少 12 位'); process.exit(1); }
if (!['ADMIN', 'SALES', 'EDITOR'].includes(role)) { console.error('ADMIN_SEED_ROLE 只能是 ADMIN/SALES/EDITOR'); process.exit(1); }

const prisma = new PrismaClient();
const exists = await prisma.user.findUnique({ where: { email } });
if (exists) { console.error(`${email} 已存在，未修改`); process.exit(1); }
const totp = totpSeed ? { totpSecret: encryptTotp(totpSeed), totpEnabled: true } : {};
const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }), ...totp } });
// 审计只记录是否预置了 2FA，不记录密钥
await prisma.auditLog.create({ data: { action: 'user.create', target: u.id, meta: { via: 'seed-script', role, totpPreset: !!totpSeed } } });
console.log(`已创建 ${role} ${email}（id ${u.id}）${totpSeed ? '，已预置 2FA（仅限非生产）' : '，请先绑定 2FA'}`);
await prisma.$disconnect();
