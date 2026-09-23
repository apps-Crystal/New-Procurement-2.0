/** GET /api/qc/[id] — the inspection, its lines, and each line's checklist points. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getInspection } from '@/lib/services/qc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) =>
  getInspection(numericId(params.id)),
);
