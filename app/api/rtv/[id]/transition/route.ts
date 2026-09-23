/**
 * POST /api/rtv/[id]/transition
 * Body { action: 'approve' | 'dispatch' | 'acknowledge' | 'close' | 'cancel', … }
 *
 * Approval is where the documents are minted and where stock moves — or does
 * not. Only a warehouse-damage return has anything to take out of a balance;
 * QC rejections and shortfalls never entered stock, so approving them posts
 * nothing. See the note at the top of lib/services/rtv.ts.
 */
import {
  handlerWithParams, numericId, readJson, optionalString, requireEnum, requireString,
} from '@/lib/api';
import {
  acknowledgeRtv, approveRtv, cancelRtv, closeRtv, dispatchRtv,
} from '@/lib/services/rtv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['approve', 'dispatch', 'acknowledge', 'close', 'cancel'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'approve':
      return approveRtv(actor, id);
    case 'dispatch':
      return dispatchRtv(actor, id, {
        transporter: optionalString(body.transporter, 'transporter', 120),
        lrNo: optionalString(body.lr_no, 'lr_no', 80),
        ewayBillNo: optionalString(body.eway_bill_no, 'eway_bill_no', 80),
      });
    case 'acknowledge':
      return acknowledgeRtv(actor, id, requireString(body.vendor_rma_no, 'vendor_rma_no', { max: 80 }));
    case 'close':
      return closeRtv(actor, id, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'cancel':
      return cancelRtv(actor, id, requireString(body.reason, 'reason', { min: 4, max: 500 }));
  }
});
