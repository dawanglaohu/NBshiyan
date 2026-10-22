import { requireAdmin } from '@/lib/server/auth';
import { createAccountGet } from '@/lib/server/admin/account';

export const runtime = 'nodejs';

export const GET = createAccountGet({
  authorize: (request) => requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']),
});
