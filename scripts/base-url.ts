/** 发布镜像与 e2e 共用的服务地址；放在未被 .dockerignore 排除的 scripts/ 下。 */
export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE = `http://localhost:${PORT}`;
