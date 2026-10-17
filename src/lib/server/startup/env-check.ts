import { prodEnvProblems, type EnvCheckDeps } from '../../../../prod-env-check';

type Exit = (code: number) => never;

/**
 * #323：构建时的 APP_ENV。next.config 的 `env` 把 `process.env.APP_ENV_AT_BUILD` 内联成构建时 APP_ENV 的值（未设置时为空字符串），
 * 运行时改环境变量改不了它。不经 Next 打包（例如 tsx 直接跑单测）时这里是 undefined，不做比对。
 */
export const builtAppEnv = (): string | undefined => process.env.APP_ENV_AT_BUILD;

/**
 * #323：NODE_ENV=production 且构建时设了 APP_ENV（例如生产镜像 APP_ENV=production）时，运行时的 APP_ENV 必须和构建时完全一致。
 * 否则（典型情况：生产镜像运行时没设 APP_ENV）下面的启动检查会整段跳过，所以直接拒绝启动。
 * 构建时没设 APP_ENV（CI / 本地的非生产构建）不比对：运行时设了 APP_ENV=production 照样跑完整的启动检查（CI 的 standalone 启动测试就是这样）。
 * 只返回变量名和原因，不含任何值。
 */
export function appEnvMismatch(env: Record<string, string | undefined>, built: string | undefined): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (built === undefined || built === '') return null;
  if ((env.APP_ENV ?? '') === built) return null;
  return 'APP_ENV 与构建时的值不一致（运行时必须和 build 时相同；生产镜像运行时没设 APP_ENV 会跳过启动检查）';
}

/**
 * 启动时的生产配置检查（runtime 阶段，完整检查）。有问题：打印变量名和原因（不含任何值），以退出码 1 结束进程。
 * 非生产（APP_ENV 不是 production）时 prodEnvProblems 返回空；但运行时 APP_ENV 和构建时不一致（#323）照样拒绝启动。
 */
export function runStartupEnvCheck(
  env: Record<string, string | undefined> = process.env,
  deps: EnvCheckDeps & { exit?: Exit; log?: (msg: string) => void; builtAppEnv?: string } = {},
): void {
  const mismatch = appEnvMismatch(env, 'builtAppEnv' in deps ? deps.builtAppEnv : builtAppEnv());
  const problems = [...(mismatch ? [mismatch] : []), ...prodEnvProblems(env, 'runtime', deps)];
  if (!problems.length) return;
  (deps.log ?? console.error)(`生产环境配置检查未通过，拒绝启动：\n- ${problems.join('\n- ')}`);
  (deps.exit ?? ((code: number) => process.exit(code)))(1);
}
