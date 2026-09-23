/** GET /api/gate-inward/[id] — the delivery, its lines, and the cold-chain band it had to hold. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getGateInward } from '@/lib/services/gate-inward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  getGateInward(numericId(params.id)),
);
