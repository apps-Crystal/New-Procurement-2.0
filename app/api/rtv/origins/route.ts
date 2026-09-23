/**
 * GET /api/rtv/origins — things that could be returned but have not been.
 *
 * Three populations, one list: inspections that rejected something, damage
 * whose approved decision was to send it back, and shortfalls the buyer is
 * still waiting on. A cancelled return releases its origin back into this list.
 */
import { handler } from '@/lib/api';
import { returnableOrigins } from '@/lib/services/rtv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ principal }) => returnableOrigins(principal));
