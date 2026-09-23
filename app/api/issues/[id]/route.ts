/** GET /api/issues/[id] — the issue and its lines, each linked to its ledger entry. */
import { handlerWithParams, numericId } from '@/lib/api';
import { getIssue } from '@/lib/services/issues';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handlerWithParams<{ id: string }, unknown>(async ({ params }) => getIssue(numericId(params.id)));
