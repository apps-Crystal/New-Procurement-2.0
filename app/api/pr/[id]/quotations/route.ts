/** GET /api/pr/[id]/quotations — every quotation recorded against this request. */
import { handlerWithParams, numericId } from '@/lib/api';
import { listQuotations } from '@/lib/services/quotations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  listQuotations(numericId(params.id)),
);
