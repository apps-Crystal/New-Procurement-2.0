/** GET /api/inventory/ledger/[id] — one entry, with whatever reverses it or it reverses. */
import { handlerWithParams, numericId } from '@/lib/api';
import { ledgerEntry } from '@/lib/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  ledgerEntry(numericId(params.id)),
);
