/** GET /api/mr/[id] — the request with its lines, declaration and allocations. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getMr } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getMr(numericId(params.id)));
