/**
 * GET  /api/rtv?status=&source=&vendor_id=
 * POST /api/rtv   raise a return against a QC rejection, damage or a shortfall
 *
 * Quantities are not in the body. They come from the origin record — the QC
 * verdict, the damage report or the shortfall case — which is what makes a
 * return impossible to inflate beyond what actually went wrong.
 */
import { handler, readJson, optionalId, requireEnum } from '@/lib/api';
import { ENUMS } from '@/lib/enums';
import { createRtv, listRtvs } from '@/lib/services/rtv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listRtvs(principal, {
    status: p.get('status') ?? undefined,
    source: p.get('source') ?? undefined,
    vendorId: p.get('vendor_id') ? Number(p.get('vendor_id')) : undefined,
  });
});

export const POST = handler(async ({ principal, ip, req }) => {
  const body = await readJson<Record<string, unknown>>(req);

  return createRtv(
    { principal, ip },
    {
      source: requireEnum(body.source, 'source', ENUMS.rtv_source),
      basis: requireEnum(body.basis, 'basis', ENUMS.rtv_basis),
      qcId: optionalId(body.qc_id, 'qc_id'),
      damageId: optionalId(body.damage_id, 'damage_id'),
      shortfallId: optionalId(body.shortfall_id, 'shortfall_id'),
    },
  );
});
