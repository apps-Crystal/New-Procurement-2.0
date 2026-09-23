/**
 * GET  /api/qc?open=1&overdue=1   inspections, SLA-ordered
 * POST /api/qc                    start one against a gate inward
 *
 * The SLA is four hours for cold-chain cargo and forty-eight for ambient, set
 * when the inspection opens. `overdue` is computed in the view, not here.
 */
import { handler, readJson, requireId } from '@/lib/api';
import { listInspections, startInspection } from '@/lib/services/qc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listInspections(principal, {
    open: p.has('open') ? p.get('open') === '1' : undefined,
    overdue: p.has('overdue') ? p.get('overdue') === '1' : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);
  return startInspection({ principal, ip }, requireId(body.gate_inward_id, 'gate_inward_id'));
});
