import InquiryNotFound from '@/components/admin/InquiryNotFound';

// page.tsx 里 notFound() 时渲染：在后台 layout（侧栏 + 顶栏）里显示，不走前台 404
export default function NotFound() {
  return <InquiryNotFound />;
}
