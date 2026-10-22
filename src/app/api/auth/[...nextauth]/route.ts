import { handleAuth } from '@/auth';

export const runtime = 'nodejs';
export const GET = (request: Request) => handleAuth(request);
export const POST = (request: Request) => handleAuth(request);
