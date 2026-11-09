import { handleRecoveryEnroll } from '@/lib/server/admin/recovery-enrollment';
import { createAdminServices } from '@/lib/server/composition';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleRecoveryEnroll(request, createAdminServices());
}
