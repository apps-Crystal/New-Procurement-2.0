/**
 * GET /api/invoices/[id] — the invoice with its three-way match.
 *
 * The match ships with the record rather than behind a second request, so the
 * screen can show why matching is blocked at the moment it draws it blocked.
 */
import { handlerWithParams, numericId } from '@/lib/api';
import { getInvoice } from '@/lib/services/invoices';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  getInvoice(numericId(params.id)),
);
