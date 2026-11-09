/** e2e 服务地址唯一来源；放在未被 .dockerignore 排除的 scripts/ 下，使根配置的 import 仍在镜像构建上下文内。发布镜像本身不消费 E2E_PORT。 */
export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE = `http://localhost:${PORT}`;
