/**
 * GET /api/po/[id] — the order, its lines, and the issue checklist.
 *
 * The checklist ships with the record rather than behind a second request, so
 * the screen can show why the Issue button is disabled at the moment it draws
 * it disabled.
 */
import { handlerWithParams, numericId } from '@/lib/api';
import { getPo } from '@/lib/services/po';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getPo(numericId(params.id)));
