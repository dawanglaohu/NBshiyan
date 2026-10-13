// 创建第一个后台管理员。凭据只从环境变量读，不要写进仓库或 shell 历史文件。
// 用法：ADMIN_SEED_EMAIL=... ADMIN_SEED_NAME=... ADMIN_SEED_PASSWORD=... pnpm admin:create
// 创建后需先走 /api/admin/auth/enroll 绑定 2FA 才能登录。
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';

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
const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }) } });
await prisma.auditLog.create({ data: { action: 'user.create', target: u.id, meta: { via: 'seed-script', role } } });
console.log(`已创建 ${role} ${email}（id ${u.id}），请先绑定 2FA`);
await prisma.$disconnect();
