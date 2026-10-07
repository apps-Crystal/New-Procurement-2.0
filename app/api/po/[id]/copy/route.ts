/**
 * POST /api/po/[id]/copy — render the system copy of this order and file it.
 *
 * Issuing does this by itself. This exists for the two cases issuing cannot
 * cover: an order issued before the copy existed, and the rare one where the
 * render failed after the order had already been committed. Re-filing replaces
 * the previous copy rather than stacking a second one beside it.
 *
 * Permission is PO.CREATE — the same key the documents service checks before
 * anything is attached to a purchase order, so the two cannot disagree.
 */
import { handlerWithParams, numericId } from '@/lib/api';
import { can } from '@/lib/auth/permissions';
import { forbidden } from '@/lib/errors';
import { filePoCopy } from '@/lib/services/po-copy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, params }) => {
  if (!can(principal, 'PO.CREATE', null)) {
    throw forbidden('You do not have permission to file documents against a purchase order.');
  }

  return filePoCopy({ principal, ip }, numericId(params.id));
});
