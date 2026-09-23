/** GET /api/damage/[id] — the report, its quarantine entry, and who has signed. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getDamage } from '@/lib/services/damage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getDamage(numericId(params.id)));
