/**
 * GET  /api/grn?status=&po_id=
 * POST /api/grn   draft a receipt from a completed inspection
 *
 * Quantities are not in the body. Each line takes the QC verdict's accepted
 * quantity plus any concession a Site Manager granted on held stock — which is
 * what `grn_lines.qty_accepted` means by "includes concession qty". All the
 * caller chooses is where each line is put away.
 */
import { handler, readJson, requireArray, requireId } from '@/lib/api';
import { createGrn, listGrns } from '@/lib/services/grn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listGrns(principal, {
    status: p.get('status') ?? undefined,
    poId: p.get('po_id') ? Number(p.get('po_id')) : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);

  const locations = body.locations === undefined ? undefined
    : requireArray<Record<string, unknown>>(body.locations, 'locations').map(l => ({
        poLineId: requireId(l.po_line_id, 'po_line_id'),
        locationId: requireId(l.location_id, 'location_id'),
      }));

  return createGrn({ principal, ip }, { qcId: requireId(body.qc_id, 'qc_id'), locations });
});
