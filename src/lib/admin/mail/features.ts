// #340 P1：「未归类邮件」整组接口（/mail/unassigned*、GET /mail/:id、assign-lookup、assign、ignore）后端还没有。
// 关闭时：侧栏不渲染入口（没有占位、没有徽标）、不轮询 unassigned/count、/admin/mail/unassigned 页面 404、
// http 客户端不发出任何这一组请求。后端接口上线并验收后把它改成 true 即可恢复（组件和接口调用都还在）。
export const UNASSIGNED_MAIL_LIVE = false as boolean;

// #340：本轮后端 attachments 恒为 []，附件下载 / 刷新链接接口（/mail/attachments/*）也还没有。
// 关闭时不渲染附件卡片（没有下载按钮），http 客户端不发 refreshLinks / download 请求。
export const MAIL_ATTACHMENTS_LIVE = false as boolean;
