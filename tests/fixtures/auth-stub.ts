// 测试用：替换 '@/auth'，会话由 globalThis.__testSession 提供
export const auth = async () => (globalThis as { __testSession?: unknown }).__testSession ?? null;
export const handlers = {};
