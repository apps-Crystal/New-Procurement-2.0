/**
 * Gate inward (brief §12) — the first moment goods exist in the system.
 *
 * INWARD_RECEIVED → QC_PENDING → QC_IN_PROGRESS → QC_COMPLETED
 *                 ↘ INWARD_REJECTED
 *
 * Nothing here touches stock. A gate inward records what arrived at the gate,
 * counted by hand; stock is posted only when a GRN is approved, after QC. That
 * gap is deliberate — material sitting in the receiving bay is not inventory.
 *
 * Three rules the schema enforces and this module only arranges for:
 *
 *   gi_vehicle_format        CHECK  — the vehicle number, normalised first
 *   gate_inwards_challan_uq  partial UNIQUE INDEX — one live challan per PO
 *   gi_reject_reason         CHECK  — a rejection carries its reason
 *
 * And two it decides, because the schema cannot:
 *
 *   C-09  Excess is recorded, never clamped. `qty_counted` is what was counted,
 *         even above the challan. The consequence lands at GRN approval, where
 *         an over-receipt must be flagged rather than silently accepted.
 *
 *   C-11  `temp_in_tolerance` is derived here from the item classes on the PO
 *         lines — the tightest band where they differ — and never accepted from
 *         the client. A thermometer reading typed by the person being measured
 *         is not a control.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/notify';
import { assertTransition, lockAndReadStatus } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { normaliseText, validateVehicleNo } from '@/lib/validate';
import { raiseShortfalls } from '@/lib/services/shortfall';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'GATE_INWARD';

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that at the gate.');
  }
}

async function loadGi(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM gate_inwards WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM gate_inwards WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That gate inward no longer exists.');
  return rows[0];
}

// =============================================================================
// Cold chain (conflict C-11)
// =============================================================================

export interface ColdChainBand {
  required: boolean;
  minC: number | null;
  maxC: number | null;
  requiresDataLogger: boolean;
  /** Item classes that imposed the band, for the message on a breach. */
  classes: string[];
}

/**
 * The temperature band a consignment must hold.
 *
 * Derived from the item classes of the PO lines being delivered. Where a load
 * mixes classes the TIGHTEST band wins — the highest floor and the lowest
 * ceiling — because a single reefer cannot run two set points, and the stricter
 * cargo is the one that spoils.
 *
 * A load with no cold-chain line has no band, and all three temperature fields
 * stay null rather than being filled with zeroes that would read as a reading.
 */
export async function coldChainBand(tx: Tx, poLineIds: number[]): Promise<ColdChainBand> {
  if (poLineIds.length === 0) {
    return { required: false, minC: null, maxC: null, requiresDataLogger: false, classes: [] };
  }

  const rows = await tx<{ code: string; temp_min_c: string; temp_max_c: string; requires_data_logger: boolean }[]>`
    SELECT DISTINCT c.code, c.temp_min_c, c.temp_max_c, c.requires_data_logger
      FROM po_lines l
      JOIN items i       ON i.id = l.item_id
      JOIN item_classes c ON c.id = i.item_class_id
     WHERE l.id = ANY(${poLineIds}) AND c.is_cold_chain`;

  if (rows.length === 0) {
    return { required: false, minC: null, maxC: null, requiresDataLogger: false, classes: [] };
  }

  return {
    required: true,
    minC: Math.max(...rows.map(r => Number(r.temp_min_c))),
    maxC: Math.min(...rows.map(r => Number(r.temp_max_c))),
    requiresDataLogger: rows.some(r => r.requires_data_logger),
    classes: rows.map(r => r.code),
  };
}

/**
 * Was the reefer within band?
 *
 * Returns null when no band applies, which is what `temp_in_tolerance` should
 * hold for an ambient load — "not applicable", not "failed".
 */
function evaluateTemperature(band: ColdChainBand, actual: number | null): boolean | null {
  if (!band.required) return null;
  if (actual === null) return false; // a cold-chain load with no reading has not been shown to be safe
  return actual >= (band.minC as number) && actual <= (band.maxC as number);
}

// =============================================================================
// Create
// =============================================================================

export interface GateInwardLineInput {
  poLineId: number;
  qtyPerChallan: string;
  qtyCounted: string;
}

export interface GateInwardInput {
  poId: number;
  vehicleNo: string;
  challanNo: string;
  challanDate: string;
  driverName?: string | null;
  transporter?: string | null;
  lrNo?: string | null;
  sealNo?: string | null;
  reeferSetPointC?: string | null;
  reeferActualC?: string | null;
  capturedOffline?: boolean;
  isReplacement?: boolean;
  replacementRtvId?: number | null;
  lines: GateInwardLineInput[];
}

/**
 * Log a delivery at the gate.
 *
 * The counted quantity is recorded exactly as counted. Where it exceeds the
 * challan the excess is visible (C-09) but not accepted — acceptance is a QC
 * verdict, and an over-receipt against the order is stopped at GRN approval.
 */
export async function createGateInward(actor: Actor, input: GateInwardInput): Promise<Row> {
  if (input.lines.length === 0) {
    throw badRequest('Record at least one line — what was actually delivered.', 'lines');
  }

  const vehicleNo = validateVehicleNo(input.vehicleNo);
  const challanNo = normaliseText(input.challanNo);

  return inTransaction(async tx => {
    const [po] = await tx<Row[]>`
      SELECT po.*, v.legal_name AS vendor_name FROM purchase_orders po
        JOIN vendors v ON v.id = po.vendor_id
       WHERE po.id = ${input.poId}`;
    if (!po) throw notFound('That purchase order no longer exists.');

    const siteId = Number(po.site_id);
    requirePermission(actor, 'GATE_INWARD.CREATE', siteId);

    // An order that was never issued has no delivery to expect.
    if (!['PO_CREATED', 'PO_PARTIALLY_RECEIVED'].includes(String(po.status))) {
      throw conflict(
        `Purchase order ${po.po_no} is ${po.status}. Only an issued order can take a delivery.`,
      );
    }

    // The unique index would catch this, but naming the existing gate inward is
    // far more useful than "that record already exists" — the driver is waiting.
    const [dup] = await tx<Row[]>`
      SELECT gi_no, arrived_at FROM gate_inwards
       WHERE po_id = ${input.poId} AND challan_no = ${challanNo} AND status <> 'INWARD_REJECTED'`;
    if (dup) {
      throw conflict(
        `Challan ${challanNo} was already logged against this order as ${dup.gi_no}. Open that gate inward instead of logging it twice.`,
      );
    }

    const poLineIds = input.lines.map(l => l.poLineId);
    const lines = await tx<Row[]>`
      SELECT id, po_id, item_id FROM po_lines WHERE id = ANY(${poLineIds})`;

    for (const line of input.lines) {
      const match = lines.find(l => Number(l.id) === line.poLineId);
      if (!match) throw notFound('One of those order lines no longer exists.');
      if (Number(match.po_id) !== input.poId) {
        throw badRequest('A line on this gate inward belongs to a different purchase order.', 'lines');
      }
    }

    // C-11: the band comes from the cargo, the verdict from the reading.
    const band = await coldChainBand(tx, poLineIds);
    const actual = input.reeferActualC?.trim() ? Number(input.reeferActualC) : null;
    const tempInTolerance = evaluateTemperature(band, actual);

    if (band.required && actual === null) {
      throw badRequest(
        `This load carries cold-chain items (${band.classes.join(', ')}). Record the reefer temperature before logging it in.`,
        'reefer_actual_c',
      );
    }

    const giNo = await nextDocumentNoForSite(tx, 'GI', siteId);

    const [gi] = await tx<Row[]>`
      INSERT INTO gate_inwards (
        gi_no, po_id, site_id, vehicle_no, driver_name, transporter, lr_no, seal_no,
        challan_no, challan_date, captured_offline, reefer_set_point_c, reefer_actual_c,
        temp_in_tolerance, is_replacement, replacement_rtv_id, status, received_by)
      VALUES (
        ${giNo}, ${input.poId}, ${siteId}, ${vehicleNo},
        ${input.driverName?.trim() || null}, ${input.transporter?.trim() || null},
        ${input.lrNo?.trim() || null}, ${input.sealNo?.trim() || null},
        ${challanNo}, ${input.challanDate}, ${input.capturedOffline ?? false},
        ${band.required && input.reeferSetPointC ? input.reeferSetPointC : null},
        ${band.required ? actual : null},
        ${tempInTolerance}, ${input.isReplacement ?? false}, ${input.replacementRtvId ?? null},
        'INWARD_RECEIVED', ${actor.principal.userId})
      RETURNING *`;

    for (const line of input.lines) {
      await tx`
        INSERT INTO gate_inward_lines (gate_inward_id, po_line_id, qty_per_challan, qty_counted)
        VALUES (${gi.id as number}, ${line.poLineId}, ${line.qtyPerChallan}::numeric, ${line.qtyCounted}::numeric)`;
    }

    await audit(tx, {
      entityType: ENTITY, entityId: Number(gi.id), action: 'CREATE',
      after: {
        gi_no: giNo, po: po.po_no, challan: challanNo, vehicle: vehicleNo,
        temp_in_tolerance: tempInTolerance,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: band.required
        ? `Cold chain ${band.minC} to ${band.maxC} °C — read ${actual} °C`
        : 'Ambient load',
    });
    await enqueue(tx, {
      eventKey: 'GATE_INWARD_LOGGED', entityType: 'GATE_INWARD', entityId: Number(gi.id),
      payload: {
        reference: giNo,
        vendor: String(po.vendor_name),
        challan: challanNo,
        temperature: tempInTolerance === null ? 'not applicable' : String(tempInTolerance),
      },
    });

    return gi;
  });
}

// =============================================================================
// Transitions
// =============================================================================

/**
 * Hand the consignment to QC, and raise a shortfall case for anything missing.
 *
 * The shortfall is raised HERE rather than at QC because it is a gate fact: the
 * challan said one number and the count said another, and that is settled before
 * anybody inspects quality. `gate_inward_lines.qty_short` is a generated column,
 * so what is raised cannot disagree with what was counted.
 */
export async function sendToQc(actor: Actor, giId: number): Promise<{ gi: Row; shortfalls: Row[] }> {
  return inTransaction(async tx => {
    const gi = await loadGi(tx, giId, true);
    const siteId = Number(gi.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(gi.status), to: 'QC_PENDING', principal: actor.principal, siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE gate_inwards SET status = 'QC_PENDING', updated_at = now()
       WHERE id = ${giId} RETURNING *`;

    const shortfalls = await raiseShortfalls(tx, giId, actor);

    await audit(tx, {
      entityType: ENTITY, entityId: giId, action: 'TRANSITION',
      fromStatus: String(gi.status), toStatus: 'QC_PENDING',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: shortfalls.length
        ? `Sent to QC; ${shortfalls.length} shortfall ${shortfalls.length === 1 ? 'case' : 'cases'} raised`
        : 'Sent to QC',
    });

    return { gi: updated, shortfalls };
  });
}

/** Turn the vehicle away. Nothing was received, so nothing needs reversing. */
export async function rejectGateInward(actor: Actor, giId: number, reason: string): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 4) {
    throw badRequest('Turning a delivery away needs a reason.', 'rejection_reason');
  }

  return inTransaction(async tx => {
    const current = await lockAndReadStatus(tx, 'gate_inwards', giId);
    if (!current) throw notFound('That gate inward no longer exists.');

    await assertTransition(
      {
        entityType: ENTITY, from: current.status, to: 'INWARD_REJECTED',
        principal: actor.principal, siteId: current.siteId,
      },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE gate_inwards
         SET status = 'INWARD_REJECTED', rejection_reason = ${text}, updated_at = now()
       WHERE id = ${giId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: giId, action: 'TRANSITION',
      fromStatus: current.status, toStatus: 'INWARD_REJECTED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listGateInwards(
  principal: Principal,
  filters: { status?: string; poId?: number; siteId?: number } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT g.*, s.code AS site_code, s.name AS site_name, po.po_no,
           v.legal_name AS vendor_name, u.full_name AS received_by_name,
           q.id AS qc_id, q.qc_no,
           (SELECT count(*) FROM gate_inward_lines l WHERE l.gate_inward_id = g.id)        AS line_count,
           (SELECT coalesce(sum(l.qty_counted), 0) FROM gate_inward_lines l
             WHERE l.gate_inward_id = g.id)                                                AS qty_counted,
           (SELECT coalesce(sum(l.qty_short), 0) FROM gate_inward_lines l
             WHERE l.gate_inward_id = g.id)                                                AS qty_short
      FROM gate_inwards g
      JOIN sites s           ON s.id = g.site_id
      JOIN purchase_orders po ON po.id = g.po_id
      JOIN vendors v         ON v.id = po.vendor_id
      JOIN app_users u       ON u.id = g.received_by
      LEFT JOIN qc_inspections q ON q.gate_inward_id = g.id AND q.is_reinspection_of IS NULL
     WHERE (${siteIds}::bigint[] IS NULL OR g.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR g.status = ${filters.status ?? null}::gate_status)
       AND (${filters.poId ?? null}::bigint IS NULL OR g.po_id = ${filters.poId ?? null})
       AND (${filters.siteId ?? null}::bigint IS NULL OR g.site_id = ${filters.siteId ?? null})
     ORDER BY g.arrived_at DESC`;
}

export async function getGateInward(id: number): Promise<{ gi: Row; lines: Row[]; band: ColdChainBand }> {
  const [gi] = await sql<Row[]>`
    SELECT g.*, s.code AS site_code, s.name AS site_name, po.po_no, po.id AS po_id,
           v.legal_name AS vendor_name, u.full_name AS received_by_name,
           q.id AS qc_id, q.qc_no
      FROM gate_inwards g
      JOIN sites s            ON s.id = g.site_id
      JOIN purchase_orders po ON po.id = g.po_id
      JOIN vendors v          ON v.id = po.vendor_id
      JOIN app_users u        ON u.id = g.received_by
      LEFT JOIN qc_inspections q ON q.gate_inward_id = g.id AND q.is_reinspection_of IS NULL
     WHERE g.id = ${id}`;

  if (!gi) throw notFound('That gate inward no longer exists.');

  const lines = await sql<Row[]>`
    SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom,
           pl.qty_ordered, pl.rate,
           -- C-09: excess is derived and shown, never folded into the count.
           -- Cast to match qty_short's scale: greatest() against an untyped 0
           -- returns '0' rather than '0.000', and a column that changes shape
           -- depending on its value is a trap for whoever formats it.
           greatest(l.qty_counted - l.qty_per_challan, 0)::numeric(14,3) AS qty_excess,
           c.code AS item_class_code, c.is_cold_chain
      FROM gate_inward_lines l
      JOIN po_lines pl     ON pl.id = l.po_line_id
      JOIN items i         ON i.id = pl.item_id
      JOIN item_classes c  ON c.id = i.item_class_id
     WHERE l.gate_inward_id = ${id} ORDER BY l.id`;

  const band = await inTransaction(tx => coldChainBand(tx, lines.map(l => Number(l.po_line_id))));

  return { gi, lines, band };
}

/** Deliveries logged and waiting to be inspected — the QC queue's source. */
export function awaitingQc(principal: Principal): Promise<Row[]> {
  return listGateInwards(principal, { status: 'QC_PENDING' });
}
