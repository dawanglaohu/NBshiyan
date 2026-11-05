import { handleRecoveryStart } from '@/lib/server/admin/recovery-start';
import { createAdminServices } from '@/lib/server/composition';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleRecoveryStart(request, createAdminServices());
}
