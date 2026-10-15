import { DetailPage, detailMetadata } from '@/components/cms/cmsPages';

export const revalidate = 3600;
export const dynamicParams = true;
export const generateMetadata = detailMetadata('article', '/articles');
export default DetailPage('article', '/articles');
