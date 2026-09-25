/**
 * Purchase return to vendor (brief §20).
 *
 * RTV_DRAFT → RTV_APPROVED → RTV_DISPATCHED → RTV_ACKNOWLEDGED → RTV_CLOSED
 *           ↘ RTV_CANCELLED ↙
 *
 * A return has exactly one origin, and which one it is decides whether stock
 * moves at all. That is the rule worth stating plainly, because getting it
 * wrong quietly doubles or destroys inventory:
 *
 *   QC_REJECTION      The goods failed inspection and were never received.
 *                     They are physically in the receiving bay, but no GRN line
 *                     covers them and no ledger entry exists. Returning them
 *                     posts NOTHING — there is no balance to take them from.
 *
 *   WAREHOUSE_DAMAGE  The goods were received, entered stock, and were later
 *                     found damaged. They are sitting in DAMAGED_HOLD because
 *                     the damage report quarantined them. Returning them posts
 *                     RTV_REVERSAL, which drains that hold.
 *
 *   SHORTFALL         The goods never arrived at all. There is nothing in the
 *                     building and nothing in the ledger, so again nothing to
 *                     post — the return is paperwork that lets a debit note
 *                     follow.
 *
 * The schema states the first half of this in a comment on
 * `purchase_return_lines.reversal_entry_id`: "QC rejections never entered
 * stock, so there is nothing to reverse." This module is the other half.
 *
 * What the schema enforces:
 *
 *   rtv_one_source      CHECK — exactly one of qc_id / damage_id / shortfall_id
 *   rtv_self_approval   CHECK — the approver is not the person who raised it
 *   rtv_approved_docs   CHECK — past draft, the PRN and gate pass both exist
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/notify';
import { assertTransition, lockAndReadStatus } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { postMovement } from '@/lib/services/stock';
import { normaliseText } from '@/lib/validate';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'RTV';

export type RtvSource = 'QC_REJECTION' | 'WAREHOUSE_DAMAGE' | 'SHORTFALL';
export type RtvBasis = 'CREDIT' | 'REPLACEMENT' | 'FREE_REPLACEMENT' | 'REPAIR_AND_RETURN';

/**
 * Whether stock has to come off a balance when this return is approved.
 *
 * Only warehouse damage ever entered stock. The other two are goods that are
 * physically present but unreceived, or goods that never came — neither has a
 * ledger entry to reverse.
 */
function postsReversal(source: RtvSource): boolean {
  return source === 'WAREHOUSE_DAMAGE';
}

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with purchase returns.');
  }
}

async function loadRtv(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM purchase_returns WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM purchase_returns WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That purchase return no longer exists.');
  return rows[0];
}

// =============================================================================
// Raise
// =============================================================================

export interface RtvInput {
  source: RtvSource;
  basis: RtvBasis;
  /** Exactly one of these, matching the source. */
  qcId?: number | null;
  damageId?: number | null;
  shortfallId?: number | null;
}

interface ProposedLine {
  poLineId: number;
  itemId: number;
  itemCode: string;
  qty: string;
  unitRate: string;
  gstRate: string;
  reasonCode: string;
  originalEntryId: number | null;
}

/**
 * What a return from this origin would carry.
 *
 * Exposed so the screen can show the lines before anything is raised, and so
 * `createRtv` and the preview cannot disagree about them. Quantities are never
 * accepted from the caller: they come from the QC verdict, the damage report or
 * the shortfall case, which is what makes a return impossible to inflate.
 */
export async function proposeLines(
  tx: Tx,
  source: RtvSource,
  sourceId: number,
): Promise<{ siteId: number; poId: number; vendorId: number; lines: ProposedLine[] }> {
  if (source === 'QC_REJECTION') {
    const [qc] = await tx<Row[]>`
      SELECT q.id, g.site_id, g.po_id, po.vendor_id
        FROM qc_inspections q
        JOIN gate_inwards g      ON g.id = q.gate_inward_id
        JOIN purchase_orders po  ON po.id = g.po_id
       WHERE q.id = ${sourceId}`;
    if (!qc) throw notFound('That inspection no longer exists.');

    // Rejected outright, plus anything a Site Manager decided to send back
    // rather than take on concession.
    const rows = await tx<Row[]>`
      SELECT l.po_line_id, pl.item_id, i.code AS item_code, pl.rate, pl.gst_rate,
             q.qty_rejected, q.reason_code,
             coalesce(d.qty, 0) AS returned_from_hold
        FROM qc_lines q
        JOIN gate_inward_lines l ON l.id = q.gate_inward_line_id
        JOIN po_lines pl         ON pl.id = l.po_line_id
        JOIN items i             ON i.id = pl.item_id
        LEFT JOIN qc_hold_decisions d ON d.qc_line_id = q.id AND d.decision = 'REJECT'
       WHERE q.qc_id = ${sourceId}
       ORDER BY q.id`;

    const lines = rows
      .map(r => ({
        poLineId: Number(r.po_line_id),
        itemId: Number(r.item_id),
        itemCode: String(r.item_code),
        qty: (Number(r.qty_rejected) + Number(r.returned_from_hold)).toFixed(3),
        unitRate: String(r.rate),
        gstRate: String(r.gst_rate),
        reasonCode: String(r.reason_code ?? 'QC_REJECTED'),
        // Never received, so there is no entry to reverse.
        originalEntryId: null,
      }))
      .filter(l => Number(l.qty) > 0);

    return { siteId: Number(qc.site_id), poId: Number(qc.po_id), vendorId: Number(qc.vendor_id), lines };
  }

  if (source === 'WAREHOUSE_DAMAGE') {
    const [dmg] = await tx<Row[]>`
      SELECT d.*, i.code AS item_code, gl.po_line_id, pl.rate, pl.gst_rate,
             po.vendor_id, po.id AS po_id
        FROM damage_reports d
        JOIN items i         ON i.id = d.item_id
        LEFT JOIN grn_lines gl ON gl.id = d.source_grn_line_id
        LEFT JOIN po_lines pl  ON pl.id = gl.po_line_id
        LEFT JOIN grns g       ON g.id = gl.grn_id
        LEFT JOIN purchase_orders po ON po.id = g.po_id
       WHERE d.id = ${sourceId}`;
    if (!dmg) throw notFound('That damage report no longer exists.');

    // A return goes to a vendor, and the vendor is only known through the
    // receipt. Damage on stock with no traceable receipt can be written off or
    // repaired, but it cannot be sent back to anybody.
    if (!dmg.po_id) {
      throw conflict(
        `${dmg.dmg_no} cannot be returned: the stock has no receipt behind it, so there is no vendor to return it to. It can be repaired or written off instead.`,
      );
    }

    return {
      siteId: Number(dmg.site_id),
      poId: Number(dmg.po_id),
      vendorId: Number(dmg.vendor_id),
      lines: [
        {
          poLineId: Number(dmg.po_line_id),
          itemId: Number(dmg.item_id),
          itemCode: String(dmg.item_code),
          qty: String(dmg.qty),
          unitRate: String(dmg.rate),
          gstRate: String(dmg.gst_rate),
          reasonCode: String(dmg.cause),
          originalEntryId: dmg.quarantine_entry_id === null ? null : Number(dmg.quarantine_entry_id),
        },
      ],
    };
  }

  const [shortfall] = await tx<Row[]>`
    SELECT c.*, i.code AS item_code, pl.rate, pl.gst_rate, pl.item_id,
           po.vendor_id, po.id AS po_id, g.site_id
      FROM shortfall_cases c
      JOIN gate_inward_lines l ON l.id = c.gate_inward_line_id
      JOIN gate_inwards g      ON g.id = l.gate_inward_id
      JOIN po_lines pl         ON pl.id = c.po_line_id
      JOIN items i             ON i.id = pl.item_id
      JOIN purchase_orders po  ON po.id = pl.po_id
     WHERE c.id = ${sourceId}`;
  if (!shortfall) throw notFound('That shortfall case no longer exists.');

  return {
    siteId: Number(shortfall.site_id),
    poId: Number(shortfall.po_id),
    vendorId: Number(shortfall.vendor_id),
    lines: [
      {
        poLineId: Number(shortfall.po_line_id),
        itemId: Number(shortfall.item_id),
        itemCode: String(shortfall.item_code),
        qty: String(shortfall.qty_short),
        unitRate: String(shortfall.rate),
        gstRate: String(shortfall.gst_rate),
        reasonCode: 'SHORT_DELIVERY',
        // Nothing arrived, so nothing was ever posted.
        originalEntryId: null,
      },
    ],
  };
}

/** Raise a return against whichever origin it comes from. */
export async function createRtv(actor: Actor, input: RtvInput): Promise<Row> {
  const sourceId =
    input.source === 'QC_REJECTION' ? input.qcId
      : input.source === 'WAREHOUSE_DAMAGE' ? input.damageId
        : input.shortfallId;

  if (!sourceId) {
    throw badRequest(`A ${input.source.replace(/_/g, ' ').toLowerCase()} return needs its source record.`, 'source');
  }

  return inTransaction(async tx => {
    const { siteId, poId, vendorId, lines } = await proposeLines(tx, input.source, sourceId);

    requirePermission(actor, 'RTV.CREATE', siteId);

    if (lines.length === 0) {
      throw conflict('There is nothing to return from that record.');
    }

    // One live return per origin. A cancelled one may be replaced.
    const [existing] = await tx<Row[]>`
      SELECT rtv_no FROM purchase_returns
       WHERE status <> 'RTV_CANCELLED'
         AND (   (${input.source} = 'QC_REJECTION'     AND qc_id = ${sourceId})
              OR (${input.source} = 'WAREHOUSE_DAMAGE' AND damage_id = ${sourceId})
              OR (${input.source} = 'SHORTFALL'        AND shortfall_id = ${sourceId}))`;
    if (existing) {
      throw conflict(`That has already been returned as ${existing.rtv_no}.`);
    }

    const rtvNo = await nextDocumentNoForSite(tx, 'RTV', siteId);

    const [rtv] = await tx<Row[]>`
      INSERT INTO purchase_returns (rtv_no, site_id, vendor_id, po_id, source, basis,
                                    qc_id, damage_id, shortfall_id, status, raised_by)
      VALUES (${rtvNo}, ${siteId}, ${vendorId}, ${poId}, ${input.source}::rtv_source,
              ${input.basis}::rtv_basis,
              ${input.source === 'QC_REJECTION' ? sourceId : null},
              ${input.source === 'WAREHOUSE_DAMAGE' ? sourceId : null},
              ${input.source === 'SHORTFALL' ? sourceId : null},
              'RTV_DRAFT', ${actor.principal.userId})
      RETURNING *`;

    for (const line of lines) {
      await tx`
        INSERT INTO purchase_return_lines (rtv_id, po_line_id, item_id, qty, unit_rate,
                                           gst_rate, reason_code, original_entry_id)
        VALUES (${rtv.id as number}, ${line.poLineId}, ${line.itemId}, ${line.qty}::numeric,
                ${line.unitRate}::numeric, ${line.gstRate}::numeric, ${line.reasonCode},
                ${line.originalEntryId})`;
    }

    await audit(tx, {
      entityType: ENTITY, entityId: Number(rtv.id), action: 'CREATE',
      after: { rtv_no: rtvNo, source: input.source, basis: input.basis, lines: lines.length },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: postsReversal(input.source)
        ? 'Stock will come out of damaged hold on approval'
        : 'Nothing to reverse — this stock never entered inventory',
    });

    return rtv;
  });
}

// =============================================================================
// Approve — mints the documents, and moves stock only where there is any
// =============================================================================

/**
 * Approve the return.
 *
 * Two documents are minted here because `rtv_approved_docs` requires both from
 * this point on: the PRN, which is the commercial record a debit note is raised
 * against, and the returnable gate pass, which is what lets the goods leave the
 * premises. Minting them at approval rather than at dispatch is the schema's
 * choice, and it is the right one — the gate needs the pass in hand before the
 * lorry arrives.
 *
 * The stock movement, or its absence, is the important part. See the note at
 * the top of this module.
 */
export async function approveRtv(actor: Actor, rtvId: number): Promise<{ rtv: Row; entries: number[] }> {
  return inTransaction(async tx => {
    const rtv = await loadRtv(tx, rtvId, true);
    const siteId = Number(rtv.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(rtv.status), to: 'RTV_APPROVED', principal: actor.principal, siteId },
      tx,
    );

    // `rtv_self_approval` enforces this, but its message names nobody.
    if (Number(rtv.raised_by) === actor.principal.userId) {
      throw forbidden('You raised this return, so it has to be approved by somebody else.');
    }

    const lines = await tx<Row[]>`
      SELECT l.*, i.code AS item_code FROM purchase_return_lines l
        JOIN items i ON i.id = l.item_id
       WHERE l.rtv_id = ${rtvId} ORDER BY l.id`;

    const source = String(rtv.source) as RtvSource;
    const entries: number[] = [];

    if (postsReversal(source)) {
      for (const line of lines) {
        const entryId = await postMovement(tx, {
          siteId,
          itemId: Number(line.item_id),
          movement: 'RTV_REVERSAL',
          from: 'DAMAGED_HOLD',
          to: null,
          qty: String(line.qty),
          sourceType: 'RTV_LINE',
          sourceId: Number(line.id),
          userId: actor.principal.userId,
          unitValue: String(line.unit_rate),
          remarks: `${rtv.rtv_no}: returned to vendor`,
        });

        await tx`UPDATE purchase_return_lines SET reversal_entry_id = ${entryId} WHERE id = ${line.id as number}`;
        entries.push(entryId);
      }
    }

    const prnNo = await nextDocumentNoForSite(tx, 'PRN', siteId);
    const gatePassNo = await nextDocumentNoForSite(tx, 'RGP', siteId);

    const [updated] = await tx<Row[]>`
      UPDATE purchase_returns
         SET status = 'RTV_APPROVED', prn_no = ${prnNo}, gate_pass_no = ${gatePassNo},
             approved_by = ${actor.principal.userId}, approved_at = now(), updated_at = now()
       WHERE id = ${rtvId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: rtvId, action: 'TRANSITION',
      fromStatus: String(rtv.status), toStatus: 'RTV_APPROVED',
      after: { prn_no: prnNo, gate_pass_no: gatePassNo, entries },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: postsReversal(source)
        ? `Stock drained from damaged hold — ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
        : 'No stock movement: this material never entered inventory',
    });
    await enqueue(tx, {
      eventKey: 'RTV_APPROVED', entityType: 'RTV', entityId: rtvId,
      payload: { reference: String(rtv.rtv_no), prn: prnNo, gate_pass: gatePassNo },
    });

    return { rtv: updated, entries };
  });
}

// =============================================================================
// Dispatch, acknowledge, close, cancel
// =============================================================================

export interface DispatchInput {
  transporter?: string | null;
  lrNo?: string | null;
  ewayBillNo?: string | null;
}

/** Send the goods back. The gate pass minted at approval is what they travel on. */
export async function dispatchRtv(actor: Actor, rtvId: number, input: DispatchInput): Promise<Row> {
  return inTransaction(async tx => {
    const rtv = await loadRtv(tx, rtvId, true);
    const siteId = Number(rtv.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(rtv.status), to: 'RTV_DISPATCHED', principal: actor.principal, siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE purchase_returns
         SET status = 'RTV_DISPATCHED', dispatched_at = now(),
             transporter   = ${input.transporter?.trim() || null},
             lr_no         = ${input.lrNo?.trim() || null},
             eway_bill_no  = ${input.ewayBillNo?.trim() || null},
             updated_at    = now()
       WHERE id = ${rtvId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: rtvId, action: 'TRANSITION',
      fromStatus: String(rtv.status), toStatus: 'RTV_DISPATCHED',
      after: { transporter: input.transporter, lr_no: input.lrNo, eway_bill_no: input.ewayBillNo },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Left on gate pass ${rtv.gate_pass_no}`,
    });

    return updated;
  });
}

/**
 * The vendor confirms receipt, with their own reference.
 *
 * The RMA number is what a credit note or a replacement will be chased against,
 * so it is required rather than optional — an acknowledgement nobody can quote
 * back to the vendor is not an acknowledgement.
 */
export async function acknowledgeRtv(actor: Actor, rtvId: number, vendorRmaNo: string): Promise<Row> {
  const rma = normaliseText(vendorRmaNo);
  if (!rma) {
    throw badRequest('Record the vendor’s reference — it is what a credit note gets chased against.', 'vendor_rma_no');
  }

  return inTransaction(async tx => {
    const rtv = await loadRtv(tx, rtvId, true);
    const siteId = Number(rtv.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(rtv.status), to: 'RTV_ACKNOWLEDGED', principal: actor.principal, siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE purchase_returns
         SET status = 'RTV_ACKNOWLEDGED', vendor_rma_no = ${rma},
             acknowledged_at = now(), updated_at = now()
       WHERE id = ${rtvId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: rtvId, action: 'TRANSITION',
      fromStatus: String(rtv.status), toStatus: 'RTV_ACKNOWLEDGED',
      after: { vendor_rma_no: rma },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Vendor acknowledged as ${rma}`,
    });

    return updated;
  });
}

/**
 * Close the return.
 *
 * What closes it depends on the basis: a CREDIT return is closed once the
 * credit note lands, a REPLACEMENT once the replacement is received. Neither of
 * those is built yet, so closing is a deliberate act by Accounts rather than
 * something derived — and it says so on the screen rather than implying the
 * system checked.
 */
export async function closeRtv(actor: Actor, rtvId: number, remarks?: string): Promise<Row> {
  return inTransaction(async tx => {
    const current = await lockAndReadStatus(tx, 'purchase_returns', rtvId);
    if (!current) throw notFound('That purchase return no longer exists.');

    await assertTransition(
      { entityType: ENTITY, from: current.status, to: 'RTV_CLOSED', principal: actor.principal, siteId: current.siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE purchase_returns SET status = 'RTV_CLOSED', closed_at = now(), updated_at = now()
       WHERE id = ${rtvId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: rtvId, action: 'TRANSITION',
      fromStatus: current.status, toStatus: 'RTV_CLOSED',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: remarks?.trim() || null,
    });

    return updated;
  });
}

/**
 * Cancel the return.
 *
 * Cancelling after approval has to put back whatever approval took out. The
 * reversal is posted through `reverseEntry`'s own mirror logic — this does not
 * invent a movement, it undoes the one it can name.
 */
export async function cancelRtv(actor: Actor, rtvId: number, reason: string): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 4) {
    throw badRequest('Cancelling a return needs a reason.', 'cancelled_reason');
  }

  return inTransaction(async tx => {
    const rtv = await loadRtv(tx, rtvId, true);
    const siteId = Number(rtv.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(rtv.status), to: 'RTV_CANCELLED', principal: actor.principal, siteId },
      tx,
    );

    // Anything approval drained has to come back, or the stock simply vanishes.
    const posted = await tx<Row[]>`
      SELECT id, reversal_entry_id, item_id, qty, unit_rate
        FROM purchase_return_lines
       WHERE rtv_id = ${rtvId} AND reversal_entry_id IS NOT NULL`;

    for (const line of posted) {
      await postMovement(tx, {
        siteId,
        itemId: Number(line.item_id),
        movement: 'REVERSAL',
        from: null,
        to: 'DAMAGED_HOLD',
        qty: String(line.qty),
        sourceType: 'RTV_LINE',
        sourceId: Number(line.id),
        userId: actor.principal.userId,
        unitValue: String(line.unit_rate),
        reversesEntryId: Number(line.reversal_entry_id),
        remarks: `${rtv.rtv_no} cancelled: ${text}`,
      });
    }

    const [updated] = await tx<Row[]>`
      UPDATE purchase_returns
         SET status = 'RTV_CANCELLED', cancelled_reason = ${text}, updated_at = now()
       WHERE id = ${rtvId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: rtvId, action: 'TRANSITION',
      fromStatus: String(rtv.status), toStatus: 'RTV_CANCELLED',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: posted.length
        ? `${text} — ${posted.length} ${posted.length === 1 ? 'line' : 'lines'} returned to damaged hold`
        : text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listRtvs(
  principal: Principal,
  filters: { status?: string; source?: string; vendorId?: number } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT r.*, s.code AS site_code, s.name AS site_name,
           v.legal_name AS vendor_name, po.po_no,
           u.full_name AS raised_by_name, a.full_name AS approved_by_name,
           (SELECT count(*) FROM purchase_return_lines l WHERE l.rtv_id = r.id)                  AS line_count,
           (SELECT coalesce(sum(l.qty), 0) FROM purchase_return_lines l WHERE l.rtv_id = r.id)   AS total_qty,
           (SELECT coalesce(sum(round(l.qty * l.unit_rate * (1 + l.gst_rate / 100), 2)), 0)
              FROM purchase_return_lines l WHERE l.rtv_id = r.id)                                AS value
      FROM purchase_returns r
      JOIN sites s            ON s.id = r.site_id
      JOIN vendors v          ON v.id = r.vendor_id
      JOIN purchase_orders po ON po.id = r.po_id
      JOIN app_users u        ON u.id = r.raised_by
      LEFT JOIN app_users a   ON a.id = r.approved_by
     WHERE (${siteIds}::bigint[] IS NULL OR r.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR r.status = ${filters.status ?? null}::rtv_status)
       AND (${filters.source ?? null}::text IS NULL OR r.source = ${filters.source ?? null}::rtv_source)
       AND (${filters.vendorId ?? null}::bigint IS NULL OR r.vendor_id = ${filters.vendorId ?? null})
     ORDER BY r.created_at DESC`;
}

export async function getRtv(id: number): Promise<{ rtv: Row; lines: Row[] }> {
  const [rtv] = await sql<Row[]>`
    SELECT r.*, s.code AS site_code, s.name AS site_name,
           v.legal_name AS vendor_name, v.vendor_code, v.gstin AS vendor_gstin, v.address AS vendor_address,
           po.po_no, po.id AS po_id,
           u.full_name AS raised_by_name, a.full_name AS approved_by_name,
           q.qc_no, d.dmg_no, c.sht_no
      FROM purchase_returns r
      JOIN sites s            ON s.id = r.site_id
      JOIN vendors v          ON v.id = r.vendor_id
      JOIN purchase_orders po ON po.id = r.po_id
      JOIN app_users u        ON u.id = r.raised_by
      LEFT JOIN app_users a       ON a.id = r.approved_by
      LEFT JOIN qc_inspections q  ON q.id = r.qc_id
      LEFT JOIN damage_reports d  ON d.id = r.damage_id
      LEFT JOIN shortfall_cases c ON c.id = r.shortfall_id
     WHERE r.id = ${id}`;

  if (!rtv) throw notFound('That purchase return no longer exists.');

  const lines = await sql<Row[]>`
    SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom,
           round(l.qty * l.unit_rate, 2)                          AS line_taxable,
           round(l.qty * l.unit_rate * (1 + l.gst_rate / 100), 2) AS line_total,
           e.entry_no AS reversal_entry_no
      FROM purchase_return_lines l
      JOIN items i ON i.id = l.item_id
      LEFT JOIN stock_ledger e ON e.id = l.reversal_entry_id
     WHERE l.rtv_id = ${id} ORDER BY l.id`;

  return { rtv, lines };
}

/** Origins that could be returned but have not been. Feeds the "raise" picker. */
export async function returnableOrigins(principal: Principal): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    -- QC inspections with stock rejected outright or sent back from hold
    SELECT 'QC_REJECTION' AS source, q.id AS source_id, q.qc_no AS reference,
           g.site_id, s.name AS site_name, v.legal_name AS vendor_name, po.po_no,
           sum(q2.qty_rejected + coalesce(hd.qty, 0)) AS qty,
           max(g.arrived_at) AS at
      FROM qc_inspections q
      JOIN gate_inwards g     ON g.id = q.gate_inward_id
      JOIN sites s            ON s.id = g.site_id
      JOIN purchase_orders po ON po.id = g.po_id
      JOIN vendors v          ON v.id = po.vendor_id
      JOIN qc_lines q2        ON q2.qc_id = q.id
      LEFT JOIN qc_hold_decisions hd ON hd.qc_line_id = q2.id AND hd.decision = 'REJECT'
     WHERE q.completed_at IS NOT NULL
       AND (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
       AND NOT EXISTS (
         SELECT 1 FROM purchase_returns r
          WHERE r.qc_id = q.id AND r.status <> 'RTV_CANCELLED')
     GROUP BY q.id, q.qc_no, g.site_id, s.name, v.legal_name, po.po_no
    HAVING sum(q2.qty_rejected + coalesce(hd.qty, 0)) > 0

    UNION ALL

    -- Damage reports whose approved decision was to send it back
    SELECT 'WAREHOUSE_DAMAGE', d.id, d.dmg_no,
           d.site_id, s.name, v.legal_name, po.po_no, d.qty, d.observed_on::timestamptz
      FROM damage_reports d
      JOIN sites s      ON s.id = d.site_id
      JOIN grn_lines gl ON gl.id = d.source_grn_line_id
      JOIN grns g       ON g.id = gl.grn_id
      JOIN purchase_orders po ON po.id = g.po_id
      JOIN vendors v    ON v.id = po.vendor_id
     WHERE d.status = 'DMG_RETURN_RAISED'
       AND (${siteIds}::bigint[] IS NULL OR d.site_id = ANY(${siteIds}))
       AND NOT EXISTS (
         SELECT 1 FROM purchase_returns r
          WHERE r.damage_id = d.id AND r.status <> 'RTV_CANCELLED')

    UNION ALL

    -- Shortfalls the buyer is still waiting on
    SELECT 'SHORTFALL', c.id, c.sht_no,
           g.site_id, s.name, v.legal_name, po.po_no, c.qty_short, c.created_at
      FROM shortfall_cases c
      JOIN gate_inward_lines l ON l.id = c.gate_inward_line_id
      JOIN gate_inwards g      ON g.id = l.gate_inward_id
      JOIN sites s             ON s.id = g.site_id
      JOIN po_lines pl         ON pl.id = c.po_line_id
      JOIN purchase_orders po  ON po.id = pl.po_id
      JOIN vendors v           ON v.id = po.vendor_id
     WHERE c.decision = 'AWAIT_BALANCE'
       AND (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
       AND NOT EXISTS (
         SELECT 1 FROM purchase_returns r
          WHERE r.shortfall_id = c.id AND r.status <> 'RTV_CANCELLED')

     ORDER BY at DESC`;
}
