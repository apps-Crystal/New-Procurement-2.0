/** GET /api/transfers/[id] — the transfer with its lines. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getTransfer } from '@/lib/services/transfers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getTransfer(numericId(params.id)));
