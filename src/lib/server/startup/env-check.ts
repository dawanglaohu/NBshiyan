import { prodEnvProblems, type EnvCheckDeps } from '../../../../prod-env-check';

type Exit = (code: number) => never;

/**
 * 启动时的生产配置检查（runtime 阶段，完整检查）。有问题：打印变量名和原因（不含任何值），以退出码 1 结束进程。
 * 非生产（APP_ENV 不是 production）时 prodEnvProblems 返回空，什么也不做。
 */
export function runStartupEnvCheck(
  env: Record<string, string | undefined> = process.env,
  deps: EnvCheckDeps & { exit?: Exit; log?: (msg: string) => void } = {},
): void {
  const problems = prodEnvProblems(env, 'runtime', deps);
  if (!problems.length) return;
  (deps.log ?? console.error)(`生产环境配置检查未通过，拒绝启动：\n- ${problems.join('\n- ')}`);
  (deps.exit ?? ((code: number) => process.exit(code)))(1);
}
