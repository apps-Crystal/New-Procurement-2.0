/**
 * POST /api/damage/[id]/transition
 * Body { action: 'decide' | 'approve' | 'reject' | 'repair-complete' | 'close', … }
 *
 * `decide` proposes what happens to the stock; `approve` carries it out. They
 * are separate because a write-off is banded — the proposal opens a chain and
 * the stock is not destroyed until every level of it clears.
 *
 * `reject` only means anything on a write-off, which is the only decision with
 * a chain to refuse. A refused write-off goes back to the inspectors with the
 * stock still quarantined; nothing is destroyed on a rejection.
 */
import {
  handlerWithParams, numericId, readJson, optionalString, requireEnum,
} from '@/lib/api';
import { ENUMS } from '@/lib/enums';
import {
  approveDamageDecision, closeDamage, completeRepair, decideDamage,
} from '@/lib/services/damage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['decide', 'approve', 'reject', 'repair-complete', 'close'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'decide':
      return decideDamage(
        actor,
        id,
        requireEnum(body.decision, 'decision', ENUMS.damage_decision),
        { insuranceClaimRef: optionalString(body.insurance_claim_ref, 'insurance_claim_ref', 120) },
      );
    case 'approve':
      return approveDamageDecision(actor, id, true, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'reject':
      return approveDamageDecision(actor, id, false, optionalString(body.remarks, 'remarks', 500) ?? undefined);
    case 'repair-complete':
      return completeRepair(actor, id, optionalString(body.notes, 'notes', 1000) ?? undefined);
    case 'close':
      return closeDamage(actor, id, optionalString(body.remarks, 'remarks', 500) ?? undefined);
  }
});
