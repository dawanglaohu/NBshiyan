import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
export default createMiddleware(routing);
// /admin、/api、/s 短链接和静态资源不走多语言路由
export const config = { matcher: ['/((?!api|admin|s/|_next|_vercel|models|images|.*\\..*).*)'] };
