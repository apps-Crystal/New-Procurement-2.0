/**
 * POST /api/qc/[id]/transition
 * Body { action: 'complete' | 'reinspect' }
 *
 * Completing applies the cold-chain gates (C-11). Re-inspecting opens a NEW
 * inspection chained off this one (C-02, C-26) — the original verdict is
 * evidence and is never edited.
 */
import { handlerWithParams, numericId, readJson, requireEnum } from '@/lib/api';
import { completeInspection, reinspect } from '@/lib/services/qc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIONS = ['complete', 'reinspect'] as const;

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const id = numericId(params.id);
  const body = await readJson<Record<string, unknown>>(req);
  const action = requireEnum(body.action, 'action', ACTIONS);
  const actor = { principal, ip };

  switch (action) {
    case 'complete':
      return completeInspection(actor, id);
    case 'reinspect':
      return reinspect(actor, id);
  }
});
