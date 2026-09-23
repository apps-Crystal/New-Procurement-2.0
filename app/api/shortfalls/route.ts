/**
 * GET /api/shortfalls?decision=&po_id=
 *
 * Cases are raised automatically when a gate inward is handed to QC — there is
 * no POST, because a shortfall is not something anybody declares. It is what
 * the count found.
 */
import { handler } from '@/lib/api';
import { listShortfalls } from '@/lib/services/shortfall';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listShortfalls(principal, {
    decision: p.get('decision') ?? undefined,
    poId: p.get('po_id') ? Number(p.get('po_id')) : undefined,
  });
});
