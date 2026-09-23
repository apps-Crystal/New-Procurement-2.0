/**
 * POST /api/pr/[id]/award — choose a quotation.
 *
 * Whether the choice is the lowest is decided from the view's rank, not from
 * anything the caller claims. A non-lowest award needs a reason code and a
 * justification; too few quotations needs a waiver. Either opens its own
 * approval chain, and the PO cannot be drafted until that clears.
 */
import { handlerWithParams, numericId, readJson, optionalString, requireId } from '@/lib/api';
import { award } from '@/lib/services/quotations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return award(
    { principal, ip },
    {
      prId: numericId(params.id),
      quotationId: requireId(body.quotation_id, 'quotation_id'),
      waiverReason: optionalString(body.waiver_reason, 'waiver_reason', 500),
      reasonCode: optionalString(body.reason_code, 'reason_code', 60),
      justification: optionalString(body.justification, 'justification', 1000),
    },
  );
});
