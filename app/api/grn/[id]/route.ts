/**
 * GET /api/grn/[id] — the receipt, its lines, and any over-receipt it carries.
 *
 * The excess ships with the record rather than behind a second request, so the
 * screen can say why approval is blocked at the moment it draws it blocked.
 */
import { handlerWithParams, numericId } from '@/lib/api';
import { getGrn } from '@/lib/services/grn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getGrn(numericId(params.id)));
