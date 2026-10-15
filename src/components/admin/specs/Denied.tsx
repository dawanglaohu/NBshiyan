/** 后台页面无权访问时的提示（服务端渲染，不加载任何数据） */
export default function Denied({ status }: { status: 401 | 403 }) {
  return (
    <div role="alert">
      <h1>{status === 401 ? '请先登录' : '没有权限'}</h1>
      <p>{status === 401 ? '登录已过期或未登录，请重新登录后台。' : '产品规格只有 ADMIN 和 EDITOR 角色可以编辑。'}</p>
    </div>
  );
}
