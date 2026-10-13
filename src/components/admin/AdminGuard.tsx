'use client';
/**
 * 登录保护挂载点（由全栈/安全实现，本组件不做任何鉴权）。
 * 真正的拦截必须在服务端完成：middleware 或 /admin 路由的服务端检查 + /api/admin/* 按角色校验。
 * 这里只预留客户端体验层：例如会话过期时跳转登录页、按角色隐藏菜单。
 */
export default function AdminGuard({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
