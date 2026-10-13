import { redirect } from 'next/navigation';
// 模型列表页待做，先进入上传流程
export default function Page() { redirect('/admin/models/new'); }
