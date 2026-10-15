import { ListPage, listMetadata } from '@/components/cms/cmsPages';

export const revalidate = 3600; // ISR；Sanity webhook 按 tag 提前刷新
export const generateMetadata = listMetadata('solution', '/solutions');
export default ListPage('solution', '/solutions');
