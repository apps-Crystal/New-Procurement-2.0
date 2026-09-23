/**
 * POST /api/debit-notes/credit-notes/[id] — accept a short credit note.
 *
 * Conflict C-14. `vendor_credit_notes.accepted_short_by` is the schema's
 * intended override and nothing ever set it; setting it is what unblocks
 * reconciliation. It belongs to CG_FHEAD alone and is written to the audit
 * trail as an OVERRIDE — agreeing to take less money than was claimed is a
 * decision somebody should be able to find later.
 */
import { handlerWithParams, numericId, readJson, requireString } from '@/lib/api';
import { acceptShortCredit } from '@/lib/services/debit-notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return acceptShortCredit(
    { principal, ip },
    numericId(params.id),
    requireString(body.reason, 'reason', { min: 10, max: 1000 }),
  );
});
