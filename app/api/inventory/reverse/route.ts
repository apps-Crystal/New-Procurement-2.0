/**
 * POST /api/inventory/reverse — mirror a posted movement.
 *
 * §29: never edit, always reverse. Both entries stay visible, and the mirror is
 * built from the original inside the transaction so it is exact.
 */
import { handler, readJson, requireId, requireString } from '@/lib/api';
import { reverseMovement } from '@/lib/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return reverseMovement(
    { principal, ip },
    requireId(body.entry_id, 'entry_id'),
    requireString(body.remarks, 'remarks', { min: 4, max: 500 }),
  );
});
