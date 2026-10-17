// 服务启动时执行一次（Next instrumentation hook）。
// 自建部署用 output: 'standalone'，`node server.js` 只读取构建时序列化好的配置，不会再执行 next.config 里的 config()，
// 所以生产配置检查的 runtime 部分（密钥、数据库、存储、发信等）在这里再查一遍；缺配置直接退出（exit 1），只打印变量名和原因。
// `next start` 时 next.config 已经查过一次，这里再查是同一个纯函数、同样的结果，不会有副作用。
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runStartupEnvCheck } = await import('./lib/server/startup/env-check');
    runStartupEnvCheck();
  }
}
