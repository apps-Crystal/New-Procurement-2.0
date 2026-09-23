/**
 * GET /api/mr/ready-for-pr — approved requests with a purchase balance and no PR yet.
 *
 * Feeds the "raise a PR" picker. A request whose need was met entirely by
 * transfer has no purchase balance and does not appear.
 */
import { handler } from '@/lib/api';
import { mrsReadyForPr } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => mrsReadyForPr(principal));
