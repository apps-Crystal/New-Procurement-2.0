/** GET /api/reconciliation/[id] — the run and every item it found. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getRun } from '@/lib/services/reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getRun(numericId(params.id)));
