/** GET /api/debit-notes/[id] — the note, its credit notes and any offsets. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getDebitNote } from '@/lib/services/debit-notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  getDebitNote(numericId(params.id)),
);
