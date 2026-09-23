/**
 * GET  /api/gate-inward?status=&po_id=&site_id=
 * POST /api/gate-inward   log a delivery at the gate
 *
 * `temp_in_tolerance` is NOT in the body. It is derived server-side from the
 * item classes on the order lines (conflict C-11) — a thermometer verdict typed
 * by the person being measured is not a control.
 */
import {
  handler, readJson, optionalId, optionalString,
  requireArray, requireDate, requireId, requireString,
} from '@/lib/api';
import { createGateInward, listGateInwards } from '@/lib/services/gate-inward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listGateInwards(principal, {
    status: p.get('status') ?? undefined,
    poId: p.get('po_id') ? Number(p.get('po_id')) : undefined,
    siteId: p.get('site_id') ? Number(p.get('site_id')) : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const rawLines = requireArray<Record<string, unknown>>(body.lines, 'lines', { min: 1 });

  return createGateInward(
    { principal, ip },
    {
      poId: requireId(body.po_id, 'po_id'),
      vehicleNo: requireString(body.vehicle_no, 'vehicle_no', { max: 20 }),
      challanNo: requireString(body.challan_no, 'challan_no', { max: 80 }),
      challanDate: requireDate(body.challan_date, 'challan_date'),
      driverName: optionalString(body.driver_name, 'driver_name', 120),
      transporter: optionalString(body.transporter, 'transporter', 120),
      lrNo: optionalString(body.lr_no, 'lr_no', 80),
      sealNo: optionalString(body.seal_no, 'seal_no', 80),
      reeferSetPointC: optionalString(body.reefer_set_point_c, 'reefer_set_point_c'),
      reeferActualC: optionalString(body.reefer_actual_c, 'reefer_actual_c'),
      capturedOffline: body.captured_offline === true,
      isReplacement: body.is_replacement === true,
      replacementRtvId: optionalId(body.replacement_rtv_id, 'replacement_rtv_id'),
      lines: rawLines.map(l => ({
        poLineId: requireId(l.po_line_id, 'po_line_id'),
        qtyPerChallan: requireString(l.qty_per_challan, 'qty_per_challan'),
        qtyCounted: requireString(l.qty_counted, 'qty_counted'),
      })),
    },
  );
});
