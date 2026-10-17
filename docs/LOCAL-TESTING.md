# 本地测试（共用电脑）

```bash
# 1. 在自己的 worktree 里，基于最新 main
git -C /workspace/NBshiyan fetch origin
git -C /workspace/NBshiyan worktree add /workspace/nb-test origin/main
cd /workspace/nb-test && pnpm install --frozen-lockfile

# 2. 数据库（共用电脑上的开发库；电脑重启后需先启动服务）
sudo service postgresql start
cp .env.example .env.local
cat /workspace/.nbshiyan-dev-db.env >> .env.local   # 写入 DATABASE_URL
npx prisma db push                                  # 同步表结构

# 3. Turnstile 用 Cloudflare 官方测试密钥（总是通过），已写在 .env.example
# 4. 生产模式运行（Lighthouse/表单测试请用这个，不要用 dev）
pnpm build && pnpm start -p 3000
# 打开 http://localhost:3000/en 和 /ru
```

说明
- 没有配置 SMTP_*（SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS）时邮件只打印到终端日志，不会真的发出。
- 想测人机验证被拒的情况：把两个 Turnstile 密钥换成 Cloudflare 文档里“总是失败”的测试密钥。
- 限流：同一 IP 10 分钟最多 5 次询盘，第 6 次返回 429；测试前重启服务可清零。
- 本地没有 nginx 的 `X-Edge-Auth` / Cloudflare 请求头，IP 会记为 unknown，所有请求共用一个限流计数。
