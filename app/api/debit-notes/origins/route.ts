/**
 * GET /api/debit-notes/origins — what could be debited but has not been.
 *
 * Returns that have left the premises, and shortfalls that were short-closed. A
 * shortfall still awaiting its balance is deliberately absent: until it is
 * short-closed the vendor owes goods, not money.
 */
import { handler } from '@/lib/api';
import { debitableOrigins } from '@/lib/services/debit-notes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => debitableOrigins(principal));
