/**
 * POST /api/mr/[id]/declare — the business-impact declaration.
 *
 * The declaration is the gate between "we looked for stock" and "we will spend
 * money". `mr_declarations_impact_len` requires at least 40 characters and
 * `mr_cost_allocations` must total 100%, both enforced in the database; the
 * accepted IP is recorded here because only the request knows it.
 */
import {
  handlerWithParams, numericId, readJson, optionalString,
  requireArray, requireId, requireString,
} from '@/lib/api';
import { declare } from '@/lib/services/mr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handlerWithParams<{ id: string }, unknown>(async ({ principal, ip, req, params }) => {
  const body = await readJson<Record<string, unknown>>(req);
  const raw = requireArray<Record<string, unknown>>(body.allocations, 'allocations', { min: 1 });

  return declare(
    { principal, ip },
    numericId(params.id),
    {
      businessImpact: requireString(body.business_impact, 'business_impact', { min: 40, max: 500 }),
      budgetCodeId: requireId(body.budget_code_id, 'budget_code_id'),
      estimatedValue: requireString(body.estimated_value, 'estimated_value'),
      declarationTextVersion: optionalString(body.declaration_text_version, 'declaration_text_version', 20) ?? undefined,
      acceptedIp: ip,
      allocations: raw.map(a => ({
        siteId: requireId(a.site_id, 'site_id'),
        // Free text, not an enum: the schema's own example is "Freezer block".
        costHead: requireString(a.cost_head, 'cost_head', { max: 120 }),
        pct: requireString(a.pct, 'pct'),
      })),
    },
  );
});
