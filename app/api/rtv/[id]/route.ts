/** GET /api/rtv/[id] — the return, its lines, and whichever origin it came from. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getRtv } from '@/lib/services/rtv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getRtv(numericId(params.id)));
