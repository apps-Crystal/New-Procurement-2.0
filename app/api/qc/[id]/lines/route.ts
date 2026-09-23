/**
 * PUT /api/qc/[id]/lines — record the verdict on one line.
 *
 * `qty_delivered` is not in the body and cannot be. It was set from the gate
 * count when the inspection opened (conflict C-10); what is recorded here is
 * how that quantity splits three ways.
 */
import {
  handlerWithParams, numericId, readJson, optionalString,
  requireArray, requireEnum, requireId, requireString,
} from '@/lib/api';
import { recordVerdict } from '@/lib/services/qc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESULTS = ['PASS', 'FAIL', 'NA'] as const;

export const PUT = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);

  const checks = body.checks === undefined ? undefined
    : requireArray<Record<string, unknown>>(body.checks, 'checks').map(c => ({
        pointId: requireId(c.point_id, 'point_id'),
        result: requireEnum(c.result, 'result', RESULTS),
        note: optionalString(c.note, 'note', 500),
      }));

  return recordVerdict({ principal, ip }, numericId(params.id), {
    qcLineId: requireId(body.qc_line_id, 'qc_line_id'),
    qtyAccepted: requireString(body.qty_accepted, 'qty_accepted'),
    qtyHold: requireString(body.qty_hold, 'qty_hold'),
    qtyRejected: requireString(body.qty_rejected, 'qty_rejected'),
    reasonCode: optionalString(body.reason_code, 'reason_code', 60),
    remarks: optionalString(body.remarks, 'remarks', 1000),
    checks,
  });
});
