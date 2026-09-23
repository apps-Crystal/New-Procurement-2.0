/**
 * GET /api/qc/holds — held lines awaiting a Site Manager's decision.
 *
 * Lines that have not been inspected yet are excluded: a fresh inspection parks
 * the whole counted quantity in `qty_hold` so the sum constraint balances, and
 * that is not the same thing as stock somebody has held back.
 */
import { handler } from '@/lib/api';
import { pendingHolds } from '@/lib/services/qc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => pendingHolds(principal));
