/**
 * GET  /api/po?status=&vendor_id=
 * POST /api/po   draft an order from the awarded quotation
 *
 * The PO is assembled from the award, not from the body: quantities from the
 * PR, rates from the winning quote. A buyer may override a rate, but the
 * override carries a remark — `po_lines.rate_deviation_remark` exists so a
 * departure from the awarded price is explained rather than silent.
 */
import {
  handler, readJson, optionalString, requireArray, requireDate, requireId, requireString,
} from '@/lib/api';
import { createPo, listPos } from '@/lib/services/po';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listPos(principal, {
    status: p.get('status') ?? undefined,
    vendorId: p.get('vendor_id') ? Number(p.get('vendor_id')) : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);

  const overrides = body.line_overrides === undefined ? undefined
    : requireArray<Record<string, unknown>>(body.line_overrides, 'line_overrides').map(o => ({
        prLineId: requireId(o.pr_line_id, 'pr_line_id'),
        rate: requireString(o.rate, 'rate'),
        remark: requireString(o.remark, 'remark', { min: 4, max: 500 }),
      }));

  return createPo(
    { principal, ip },
    {
      prId: requireId(body.pr_id, 'pr_id'),
      expectedDelivery: requireDate(body.expected_delivery, 'expected_delivery'),
      freightTerms: optionalString(body.freight_terms, 'freight_terms', 500),
      installationTerms: optionalString(body.installation_terms, 'installation_terms', 500),
      lineOverrides: overrides,
    },
  );
});
