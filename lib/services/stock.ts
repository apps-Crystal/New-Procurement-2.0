/**
 * Stock movement — the ONLY way stock changes anywhere in this application.
 *
 * Brief §16: `stock_ledger` is the immutable source of truth, `stock_balances`
 * is a projection, and every movement goes through `post_stock_movement()`.
 * Nothing outside this module may write either table.
 * __tests__/architecture.test.ts enforces that by scanning the source tree.
 *
 * The database does the work here, and it is worth naming what that buys:
 *
 *   * Idempotency is the UNIQUE on `idempotency_key`, not a read-then-check.
 *   * Never-negative is `CHECK (qty >= 0)`, so no concurrency window exists.
 *   * The ledger is append-only by trigger, so tampering is impossible rather
 *     than merely detectable.
 *   * A failed step rolls the whole operation back, ledger row included.
 *
 * The key includes site_id per amendment C-01, which is what lets a transfer
 * receipt post both of its legs.
 */
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/errors';

export type StockBucket = 'AVAILABLE' | 'RESERVED' | 'IN_TRANSIT' | 'DAMAGED_HOLD' | 'UNDER_REPAIR' | 'WRITTEN_OFF';

export type MovementType =
  | 'OPENING'
  | 'GRN_RECEIPT'
  | 'ISSUE'
  | 'TRANSFER_RESERVE'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'DAMAGE_QUARANTINE'
  | 'REPAIR_START'
  | 'REPAIR_COMPLETE'
  | 'WRITE_OFF'
  | 'RTV_REVERSAL'
  | 'ADJUSTMENT'
  | 'REVERSAL';

export type SourceType =
  | 'OPENING'
  | 'GRN_LINE'
  | 'ISSUE_LINE'
  | 'TRANSFER_LINE'
  | 'DAMAGE_REPORT'
  | 'RTV_LINE'
  | 'ADJUSTMENT';

export interface MovementInput {
  siteId: number;
  itemId: number;
  movement: MovementType;
  /** Bucket stock leaves. null = arriving from outside the site. */
  from: StockBucket | null;
  /** Bucket stock enters. null = leaving the site. */
  to: StockBucket | null;
  qty: string | number;
  sourceType: SourceType;
  sourceId: number;
  userId: number;
  unitValue?: string | number | null;
  locationId?: number | null;
  assetUnitId?: number | null;
  reversesEntryId?: number | null;
  remarks?: string | null;
}

/**
 * The movement shapes this system allows.
 *
 * The schema constrains direction (`sl_has_direction`) and that a movement
 * changes bucket (`sl_bucket_change`), but not which movement type may take
 * which route — a `WRITE_OFF` straight from `AVAILABLE` would pass. This table
 * is that missing constraint, and it mirrors docs/03-screen-api-map.md.
 */
const ALLOWED: Record<MovementType, { from: StockBucket | null; to: StockBucket | null }[]> = {
  OPENING: [{ from: null, to: 'AVAILABLE' }],
  GRN_RECEIPT: [{ from: null, to: 'AVAILABLE' }],
  ISSUE: [{ from: 'AVAILABLE', to: null }],
  TRANSFER_RESERVE: [{ from: 'AVAILABLE', to: 'RESERVED' }],
  TRANSFER_OUT: [{ from: 'RESERVED', to: 'IN_TRANSIT' }],
  // Two legs, one per site — see amendment C-01.
  TRANSFER_IN: [
    { from: 'IN_TRANSIT', to: null }, // drains the sending site
    { from: null, to: 'AVAILABLE' }, // credits the receiving site
  ],
  DAMAGE_QUARANTINE: [{ from: 'AVAILABLE', to: 'DAMAGED_HOLD' }],
  REPAIR_START: [{ from: 'DAMAGED_HOLD', to: 'UNDER_REPAIR' }],
  REPAIR_COMPLETE: [{ from: 'UNDER_REPAIR', to: 'AVAILABLE' }],
  WRITE_OFF: [{ from: 'DAMAGED_HOLD', to: 'WRITTEN_OFF' }],
  RTV_REVERSAL: [{ from: 'DAMAGED_HOLD', to: null }],
  ADJUSTMENT: [
    { from: null, to: 'AVAILABLE' },
    { from: 'AVAILABLE', to: null },
  ],
  // A reversal mirrors whatever it reverses, so any shape is legal here; the
  // reversesEntryId check below is what constrains it.
  REVERSAL: [],
};

/** Exactly the key post_stock_movement() builds, including amendment C-01. */
export function idempotencyKey(
  input: Pick<MovementInput, 'sourceType' | 'sourceId' | 'movement' | 'siteId'>,
): string {
  return `${input.sourceType}:${input.sourceId}:${input.movement}:${input.siteId}`;
}

function assertShape(input: MovementInput) {
  if (input.movement === 'REVERSAL') {
    if (!input.reversesEntryId) throw new AppError('INTERNAL', 'A reversal must reference the entry it reverses.');
    return;
  }
  const ok = ALLOWED[input.movement].some(s => s.from === input.from && s.to === input.to);
  if (!ok) {
    throw new AppError(
      'INTERNAL',
      `${input.movement} cannot move stock from ${input.from ?? 'outside'} to ${input.to ?? 'outside'}.`,
    );
  }
}

/**
 * Post one stock movement. Returns the stock_ledger id — the same id on replay.
 *
 * Must be called inside a transaction: stock and the business record it belongs
 * to commit together or not at all.
 */
export async function postMovement(tx: Tx, input: MovementInput): Promise<number> {
  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new AppError('VALIDATION', 'A stock movement quantity must be greater than zero.', { field: 'qty' });
  }
  assertShape(input);

  // The quantity is passed as text so numeric(14,3) is parsed by PostgreSQL
  // rather than round-tripped through a JS float on the way in.
  const rows = await tx<{ post_stock_movement: string }[]>`
    SELECT post_stock_movement(
      ${input.siteId}, ${input.itemId}, ${input.movement}::movement_type,
      ${input.from}::stock_bucket, ${input.to}::stock_bucket, ${String(input.qty)}::numeric,
      ${input.sourceType}, ${input.sourceId}, ${input.userId},
      ${input.unitValue == null ? null : String(input.unitValue)}::numeric,
      ${input.locationId ?? null}, ${input.assetUnitId ?? null},
      ${input.reversesEntryId ?? null}, ${input.remarks ?? null}
    )`;

  return Number(rows[0].post_stock_movement);
}

/** Post several movements in order, inside one transaction. */
export async function postMovements(tx: Tx, inputs: MovementInput[]): Promise<number[]> {
  const ids: number[] = [];
  for (const input of inputs) ids.push(await postMovement(tx, input));
  return ids;
}

// --- Named movement helpers ----------------------------------------------------
// Each fixes the buckets and source type so a caller cannot get them wrong.

export const receiveFromGrn = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; grnLineId: number; userId: number; unitValue?: string | number | null; locationId?: number | null; assetUnitId?: number | null },
) => postMovement(tx, { ...a, movement: 'GRN_RECEIPT', from: null, to: 'AVAILABLE', sourceType: 'GRN_LINE', sourceId: a.grnLineId });

export const issue = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; issueLineId: number; userId: number; locationId?: number | null },
) => postMovement(tx, { ...a, movement: 'ISSUE', from: 'AVAILABLE', to: null, sourceType: 'ISSUE_LINE', sourceId: a.issueLineId });

export const reserveForTransfer = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; transferLineId: number; userId: number },
) => postMovement(tx, { ...a, movement: 'TRANSFER_RESERVE', from: 'AVAILABLE', to: 'RESERVED', sourceType: 'TRANSFER_LINE', sourceId: a.transferLineId });

export const dispatchTransfer = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; transferLineId: number; userId: number },
) => postMovement(tx, { ...a, movement: 'TRANSFER_OUT', from: 'RESERVED', to: 'IN_TRANSIT', sourceType: 'TRANSFER_LINE', sourceId: a.transferLineId });

/**
 * Receiving a transfer posts BOTH legs: it drains IN_TRANSIT at the sending
 * site and credits AVAILABLE at the receiving site. The two keys differ only by
 * site_id, which is exactly what amendment C-01 made possible.
 */
export async function receiveTransfer(
  tx: Tx,
  a: { fromSiteId: number; toSiteId: number; itemId: number; qty: string | number; transferLineId: number; userId: number; locationId?: number | null },
): Promise<{ outEntryId: number; inEntryId: number }> {
  if (a.fromSiteId === a.toSiteId) {
    throw new AppError('VALIDATION', 'A transfer must move stock between two different sites.');
  }

  const outEntryId = await postMovement(tx, {
    siteId: a.fromSiteId, itemId: a.itemId, movement: 'TRANSFER_IN', from: 'IN_TRANSIT', to: null,
    qty: a.qty, sourceType: 'TRANSFER_LINE', sourceId: a.transferLineId, userId: a.userId,
    remarks: `Received at site ${a.toSiteId}`,
  });

  const inEntryId = await postMovement(tx, {
    siteId: a.toSiteId, itemId: a.itemId, movement: 'TRANSFER_IN', from: null, to: 'AVAILABLE',
    qty: a.qty, sourceType: 'TRANSFER_LINE', sourceId: a.transferLineId, userId: a.userId,
    locationId: a.locationId ?? null, remarks: `Transferred from site ${a.fromSiteId}`,
  });

  return { outEntryId, inEntryId };
}

export const quarantineDamage = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; damageId: number; userId: number; locationId?: number | null; assetUnitId?: number | null; unitValue?: string | number | null },
) => postMovement(tx, { ...a, movement: 'DAMAGE_QUARANTINE', from: 'AVAILABLE', to: 'DAMAGED_HOLD', sourceType: 'DAMAGE_REPORT', sourceId: a.damageId });

export const startRepair = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; damageId: number; userId: number; assetUnitId?: number | null },
) => postMovement(tx, { ...a, movement: 'REPAIR_START', from: 'DAMAGED_HOLD', to: 'UNDER_REPAIR', sourceType: 'DAMAGE_REPORT', sourceId: a.damageId });

export const completeRepair = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; damageId: number; userId: number; assetUnitId?: number | null },
) => postMovement(tx, { ...a, movement: 'REPAIR_COMPLETE', from: 'UNDER_REPAIR', to: 'AVAILABLE', sourceType: 'DAMAGE_REPORT', sourceId: a.damageId });

export const writeOff = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; damageId: number; userId: number; assetUnitId?: number | null; unitValue?: string | number | null },
) => postMovement(tx, { ...a, movement: 'WRITE_OFF', from: 'DAMAGED_HOLD', to: 'WRITTEN_OFF', sourceType: 'DAMAGE_REPORT', sourceId: a.damageId });

/**
 * Stock leaving on a purchase return.
 *
 * Only for returns whose stock actually entered inventory — source
 * WAREHOUSE_DAMAGE. QC rejections and shortfalls never posted a receipt, so
 * there is nothing to reverse and this must NOT be called for them (brief §19).
 */
export const reverseForRtv = (
  tx: Tx,
  a: { siteId: number; itemId: number; qty: string | number; rtvLineId: number; userId: number; assetUnitId?: number | null; unitValue?: string | number | null; originalEntryId?: number | null },
) =>
  postMovement(tx, {
    siteId: a.siteId, itemId: a.itemId, movement: 'RTV_REVERSAL', from: 'DAMAGED_HOLD', to: null,
    qty: a.qty, sourceType: 'RTV_LINE', sourceId: a.rtvLineId, userId: a.userId,
    assetUnitId: a.assetUnitId ?? null, unitValue: a.unitValue ?? null,
    remarks: a.originalEntryId ? `Reverses receipt entry ${a.originalEntryId}` : null,
  });

/**
 * Correct a posted movement by mirroring it (brief §29 — never edit, always
 * reverse). Reads the original inside the transaction so the mirror is exact.
 */
export async function reverseEntry(tx: Tx, a: { entryId: number; userId: number; remarks: string }): Promise<number> {
  const [original] = await tx<{
    site_id: string; item_id: string; from_bucket: StockBucket | null; to_bucket: StockBucket | null;
    qty: string; source_type: SourceType; source_id: string; unit_value: string | null;
    location_id: string | null; asset_unit_id: string | null;
  }[]>`
    SELECT site_id, item_id, from_bucket, to_bucket, qty, source_type, source_id,
           unit_value, location_id, asset_unit_id
      FROM stock_ledger WHERE id = ${a.entryId}`;

  if (!original) throw new AppError('NOT_FOUND', 'That stock ledger entry no longer exists.');

  const [already] = await tx<{ id: string }[]>`
    SELECT id FROM stock_ledger WHERE reverses_entry_id = ${a.entryId}`;
  if (already) throw new AppError('CONFLICT', 'That stock movement has already been reversed.');

  return postMovement(tx, {
    siteId: Number(original.site_id),
    itemId: Number(original.item_id),
    movement: 'REVERSAL',
    from: original.to_bucket, // mirrored
    to: original.from_bucket,
    qty: original.qty,
    sourceType: original.source_type,
    sourceId: Number(original.source_id),
    userId: a.userId,
    unitValue: original.unit_value,
    locationId: original.location_id === null ? null : Number(original.location_id),
    assetUnitId: original.asset_unit_id === null ? null : Number(original.asset_unit_id),
    reversesEntryId: a.entryId,
    remarks: a.remarks,
  });
}

// --- Reads -----------------------------------------------------------------------

export interface BalanceRow {
  siteId: number;
  itemId: number;
  bucket: StockBucket;
  qty: string;
}

/** Current balances for one item at one site, by bucket. */
export async function balancesFor(tx: Tx, siteId: number, itemId: number): Promise<BalanceRow[]> {
  const rows = await tx<{ site_id: string; item_id: string; bucket: StockBucket; qty: string }[]>`
    SELECT site_id, item_id, bucket, qty
      FROM stock_balances
     WHERE site_id = ${siteId} AND item_id = ${itemId}`;

  return rows.map(r => ({ siteId: Number(r.site_id), itemId: Number(r.item_id), bucket: r.bucket, qty: r.qty }));
}

/**
 * Available quantity, locked for update.
 *
 * Use before any check-then-act decision so two concurrent requests cannot both
 * read the same availability. `CHECK (qty >= 0)` is still the backstop; this
 * turns a constraint violation into a clean message.
 */
export async function availableForUpdate(tx: Tx, siteId: number, itemId: number): Promise<number> {
  const rows = await tx<{ qty: string }[]>`
    SELECT qty FROM stock_balances
     WHERE site_id = ${siteId} AND item_id = ${itemId} AND bucket = 'AVAILABLE'
       FOR UPDATE`;
  return rows.length ? Number(rows[0].qty) : 0;
}
