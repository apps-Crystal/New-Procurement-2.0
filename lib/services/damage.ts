/**
 * Warehouse damage (brief §19) — reporting and quarantine.
 *
 * DMG_REPORTED → DMG_INSPECTED → DMG_DECISION_PENDING_APPROVAL
 *                                 ↘ DMG_UNDER_REPAIR   → DMG_CLOSED
 *                                 ↘ DMG_RETURN_RAISED  → DMG_CLOSED
 *                                 ↘ DMG_WRITTEN_OFF    → DMG_CLOSED
 *
 * Three people touch a damage report before anything is destroyed: whoever
 * found it, the two who inspect it, and whoever approves the decision. None of
 * them may be the same person as the reporter.
 *
 * Reporting quarantines immediately: the movement AVAILABLE → DAMAGED_HOLD is
 * posted in the same transaction as the report. That ordering is the point. A
 * damaged pallet that is still issuable while somebody decides about it is how
 * damaged stock reaches a customer.
 *
 * `damage_reports.in_warranty` is a generated column over `warranty_until` and
 * `observed_on`, so a warranty claim can never be raised on stock that was out
 * of warranty when the damage was seen (`dmg_warranty_claim`). The warranty date
 * is copied from the asset unit or the receipt, never typed.
 *
 * The joint inspection is genuinely joint: `damage_inspections` is keyed by
 * (damage_id, inspector_id) with the role recorded, and the report only moves
 * to DMG_INSPECTED once both a Site Manager and a QC inspector have signed.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/notify';
import { assertTransition, lockAndReadStatus } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can, rolesAt, type RoleCode } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { postMovement, availableForUpdate } from '@/lib/services/stock';
import { decide, openApprovalChain } from '@/lib/services/approvals';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'DAMAGE';

/** The two roles that must both sign a damage inspection. */
const INSPECTION_ROLES: RoleCode[] = ['CG_SMGR', 'CG_QC'];

function requirePermission(actor: Actor, key: Parameters<typeof can>[1], siteId: number | null) {
  if (!can(actor.principal, key, siteId)) {
    throw forbidden('You do not have permission to do that with damage reports.');
  }
}

async function loadDamage(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM damage_reports WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM damage_reports WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That damage report no longer exists.');
  return rows[0];
}

// =============================================================================
// Report and quarantine
// =============================================================================

export interface DamageInput {
  siteId: number;
  itemId: number;
  qty: string;
  cause: string;
  observedOn: string;
  /** The specific unit, for serialised stock. */
  assetUnitId?: number | null;
  locationId?: number | null;
  /** The receipt this stock came from — drives warranty and valuation. */
  sourceGrnLineId?: number | null;
  estimatedValue?: string | null;
}

/**
 * Report damage and quarantine the stock in one step.
 *
 * `estimated_value` is derived from the receipt rate where one is known, rather
 * than typed: it decides whether a later write-off needs an insurance reference
 * (`dmg_insurance_ref`, above ₹50,000), and a number the reporter chooses is a
 * number they can choose to keep under the threshold.
 */
export async function reportDamage(actor: Actor, input: DamageInput): Promise<Row> {
  return inTransaction(async tx => {
    requirePermission(actor, 'DAMAGE.CREATE', input.siteId);

    const [item] = await tx<Row[]>`SELECT code, name, uom, is_serialised FROM items WHERE id = ${input.itemId}`;
    if (!item) throw notFound('That item no longer exists.');

    const qty = Number(input.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw badRequest('A damaged quantity must be more than zero.', 'qty');
    }

    // A serialised item is damaged as a unit, not as a quantity.
    if (item.is_serialised === true && !input.assetUnitId) {
      throw badRequest(
        `${item.code} is serialised, so name the unit that was damaged rather than a quantity.`,
        'asset_unit_id',
      );
    }

    const available = await availableForUpdate(tx, input.siteId, input.itemId);
    if (available < qty) {
      throw conflict(
        `Only ${available} ${item.uom} of ${item.name} is available here, so ${qty} cannot be quarantined. Damage already reported does not count twice.`,
      );
    }

    // Warranty and value come from the receipt, or from the unit for serialised
    // stock. Neither is accepted from the caller.
    let warrantyUntil: string | null = null;
    let unitRate: string | null = null;
    let grnLineId = input.sourceGrnLineId ?? null;

    if (input.assetUnitId) {
      const [unit] = await tx<Row[]>`
        SELECT warranty_until, source_grn_line_id, site_id, item_id, bucket
          FROM asset_units WHERE id = ${input.assetUnitId} FOR UPDATE`;
      if (!unit) throw notFound('That asset unit no longer exists.');
      if (Number(unit.site_id) !== input.siteId || Number(unit.item_id) !== input.itemId) {
        throw badRequest('That unit is not this item at this site.', 'asset_unit_id');
      }
      if (unit.bucket !== 'AVAILABLE') {
        throw conflict(`That unit is already ${String(unit.bucket).toLowerCase().replace(/_/g, ' ')}.`);
      }
      warrantyUntil = unit.warranty_until as string | null;
      grnLineId = unit.source_grn_line_id === null ? grnLineId : Number(unit.source_grn_line_id);
    }

    if (grnLineId) {
      const [grnLine] = await tx<Row[]>`
        SELECT gl.unit_rate, i.warranty_months, g.approved_at
          FROM grn_lines gl
          JOIN grns g      ON g.id = gl.grn_id
          JOIN po_lines pl ON pl.id = gl.po_line_id
          JOIN items i     ON i.id = pl.item_id
         WHERE gl.id = ${grnLineId}`;
      if (grnLine) {
        unitRate = grnLine.unit_rate as string;
        if (!warrantyUntil && grnLine.warranty_months !== null && grnLine.approved_at) {
          const [row] = await tx<{ until: string }[]>`
            SELECT (${grnLine.approved_at as string}::date
                    + ${`${Number(grnLine.warranty_months)} months`}::interval)::date::text AS until`;
          warrantyUntil = row.until;
        }
      }
    }

    // Bulk stock is fungible: a damaged pallet off a stack of ninety cannot be
    // traced to one receipt, and asking the warehouse to name one would only
    // invite a guess dressed as a fact. So where no receipt is named, the last
    // rate this item was actually received at this site for is used — a figure
    // the system already holds, rather than one the reporter chooses.
    if (!unitRate) {
      const [last] = await tx<{ unit_value: string }[]>`
        SELECT unit_value FROM stock_ledger
         WHERE site_id = ${input.siteId} AND item_id = ${input.itemId}
           AND movement = 'GRN_RECEIPT' AND unit_value IS NOT NULL
         ORDER BY id DESC LIMIT 1`;
      unitRate = last?.unit_value ?? null;
    }

    const estimatedValue = unitRate
      ? (Number(unitRate) * qty).toFixed(2)
      : input.estimatedValue?.trim()
        ? Number(input.estimatedValue).toFixed(2)
        : null;

    // Only truly unvalued stock — never received through a GRN here, such as an
    // opening balance — needs a figure from the reporter.
    if (estimatedValue === null) {
      throw badRequest(
        'This item has never been received at this site, so it cannot be valued automatically. Give an estimated value.',
        'estimated_value',
      );
    }

    const dmgNo = await nextDocumentNoForSite(tx, 'DMG', input.siteId);

    const [report] = await tx<Row[]>`
      INSERT INTO damage_reports (dmg_no, site_id, item_id, asset_unit_id, location_id, qty, cause,
                                  observed_on, source_grn_line_id, warranty_until, estimated_value,
                                  status, reported_by)
      VALUES (${dmgNo}, ${input.siteId}, ${input.itemId}, ${input.assetUnitId ?? null},
              ${input.locationId ?? null}, ${input.qty}::numeric, ${input.cause}::damage_cause,
              ${input.observedOn}::date, ${grnLineId}, ${warrantyUntil},
              ${estimatedValue}::numeric, 'DMG_REPORTED', ${actor.principal.userId})
      RETURNING *`;

    // Quarantine now, in this transaction. Stock under question is not stock
    // anyone may issue.
    const entryId = await postMovement(tx, {
      siteId: input.siteId,
      itemId: input.itemId,
      movement: 'DAMAGE_QUARANTINE',
      from: 'AVAILABLE',
      to: 'DAMAGED_HOLD',
      qty: input.qty,
      sourceType: 'DAMAGE_REPORT',
      sourceId: Number(report.id),
      userId: actor.principal.userId,
      locationId: input.locationId ?? null,
      assetUnitId: input.assetUnitId ?? null,
      unitValue: unitRate,
      remarks: `${dmgNo}: ${input.cause}`,
    });

    const [withEntry] = await tx<Row[]>`
      UPDATE damage_reports SET quarantine_entry_id = ${entryId}, updated_at = now()
       WHERE id = ${report.id as number} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: Number(report.id), action: 'CREATE',
      after: {
        dmg_no: dmgNo, item: item.code, qty: input.qty, cause: input.cause,
        estimated_value: estimatedValue, in_warranty: withEntry.in_warranty,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Quarantined ${input.qty} ${item.uom} of ${item.name}`,
    });
    await enqueue(tx, {
      eventKey: 'DAMAGE_REPORTED', entityType: 'DAMAGE', entityId: Number(report.id),
      payload: {
        reference: dmgNo,
        item: String(item.code),
        quantity: input.qty,
        estimated_value: estimatedValue,
      },
    });

    return withEntry;
  });
}

// =============================================================================
// Joint inspection
// =============================================================================

/**
 * Sign the inspection.
 *
 * Both a Site Manager and a QC inspector must sign before the report moves on —
 * the permission grants either role, and the transition happens only once both
 * have. The reporter may not sign: someone who found the damage assessing their
 * own find is the thing a joint inspection exists to prevent.
 */
export async function inspectDamage(
  actor: Actor,
  damageId: number,
  notes: string,
): Promise<{ report: Row; signatures: Row[]; complete: boolean }> {
  const text = notes?.trim();
  if (!text || text.length < 10) {
    throw badRequest('An inspection note is the record of what was actually seen.', 'notes');
  }

  return inTransaction(async tx => {
    const report = await loadDamage(tx, damageId, true);
    const siteId = Number(report.site_id);

    requirePermission(actor, 'DAMAGE.INSPECT', siteId);

    if (String(report.status) !== 'DMG_REPORTED') {
      throw conflict(`This report is ${report.status} — its inspection is already done.`);
    }

    if (Number(report.reported_by) === actor.principal.userId) {
      throw forbidden('You reported this damage, so the inspection is somebody else’s to sign.');
    }

    // Which of the two roles this person is signing as. Holding both, the Site
    // Manager signature is taken — it is the senior one, and the QC signature
    // then still has to come from elsewhere.
    const held = rolesAt(actor.principal, siteId);
    const signingAs = INSPECTION_ROLES.find(r => held.includes(r));
    if (!signingAs) {
      throw forbidden('A damage inspection is signed by a Site Manager and a QC inspector.');
    }

    const [existing] = await tx<Row[]>`
      SELECT inspector_id FROM damage_inspections
       WHERE damage_id = ${damageId} AND inspector_id = ${actor.principal.userId}`;
    if (existing) {
      throw conflict('You have already signed this inspection.');
    }

    await tx`
      INSERT INTO damage_inspections (damage_id, inspector_id, inspector_role, notes)
      VALUES (${damageId}, ${actor.principal.userId}, ${signingAs}::role_code, ${text})`;

    const signatures = await tx<Row[]>`
      SELECT di.*, u.full_name AS inspector_name
        FROM damage_inspections di
        JOIN app_users u ON u.id = di.inspector_id
       WHERE di.damage_id = ${damageId}
       ORDER BY di.inspected_at`;

    const roles = new Set(signatures.map(s => String(s.inspector_role)));
    const complete = INSPECTION_ROLES.every(r => roles.has(r));

    let current = report;

    if (complete) {
      await assertTransition(
        { entityType: ENTITY, from: String(report.status), to: 'DMG_INSPECTED', principal: actor.principal, siteId },
        tx,
      );

      const [updated] = await tx<Row[]>`
        UPDATE damage_reports SET status = 'DMG_INSPECTED', updated_at = now()
         WHERE id = ${damageId} RETURNING *`;
      current = updated;
    }

    await audit(tx, {
      entityType: ENTITY, entityId: damageId,
      action: complete ? 'TRANSITION' : 'UPDATE',
      fromStatus: complete ? String(report.status) : null,
      toStatus: complete ? 'DMG_INSPECTED' : null,
      after: { signed_as: signingAs, signatures: signatures.length },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: complete
        ? 'Joint inspection complete'
        : `Signed as ${signingAs}; awaiting the other inspector`,
    });

    return { report: current, signatures, complete };
  });
}

// =============================================================================
// Decision (Phase 7)
// =============================================================================

export type DamageDecision = 'INTERNAL_REPAIR' | 'WARRANTY_CLAIM' | 'WRITE_OFF';

/**
 * Above this, a write-off needs an insurance claim reference
 * (`dmg_insurance_ref`). Conflict C-13: the prototype never asked for one.
 */
const INSURANCE_THRESHOLD = 50_000;

/**
 * Decide what happens to inspected damage.
 *
 * Two of the three choices are constrained by the schema rather than by
 * judgement, and both constraints are checked here so the refusal is a sentence
 * rather than a constraint name:
 *
 *   dmg_warranty_claim  A warranty claim is only possible if the stock was in
 *                       warranty ON THE DAY THE DAMAGE WAS SEEN — `in_warranty`
 *                       is generated from `warranty_until` and `observed_on`,
 *                       not from today. Sitting on a report until the warranty
 *                       lapses does not change whether the claim is valid.
 *
 *   dmg_insurance_ref   A write-off above ₹50,000 needs an insurance claim
 *                       reference (C-13).
 *
 * A write-off also opens an approval chain, banded by value — the only one of
 * the three where money is destroyed rather than moved. Repair and warranty
 * claims need a single approver.
 */
export async function decideDamage(
  actor: Actor,
  damageId: number,
  decision: DamageDecision,
  opts: { insuranceClaimRef?: string | null } = {},
): Promise<{ report: Row; levels: Row[] }> {
  return inTransaction(async tx => {
    const report = await loadDamage(tx, damageId, true);
    const siteId = Number(report.site_id);

    await assertTransition(
      {
        entityType: ENTITY, from: String(report.status), to: 'DMG_DECISION_PENDING_APPROVAL',
        principal: actor.principal, siteId,
      },
      tx,
    );

    if (decision === 'WARRANTY_CLAIM' && report.in_warranty !== true) {
      throw conflict(
        report.warranty_until
          ? `The warranty on this ran out on ${String(report.warranty_until)}, before the damage was seen on ${String(report.observed_on)}. A warranty claim is not open — repair it or write it off.`
          : 'No warranty is recorded against this stock, so there is nothing to claim under.',
      );
    }

    const value = Number(report.estimated_value);
    const insuranceRef = opts.insuranceClaimRef?.trim() || null;

    if (decision === 'WRITE_OFF' && value > INSURANCE_THRESHOLD && !insuranceRef) {
      throw badRequest(
        `A write-off of ₹${value.toLocaleString('en-IN')} is above the ₹50,000 threshold, so it needs an insurance claim reference.`,
        'insurance_claim_ref',
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE damage_reports
         SET status = 'DMG_DECISION_PENDING_APPROVAL',
             decision = ${decision}::damage_decision,
             insurance_claim_ref = ${insuranceRef},
             updated_at = now()
       WHERE id = ${damageId}
      RETURNING *`;

    // Only a write-off is banded. The others need one approver, not a chain.
    const levels =
      decision === 'WRITE_OFF'
        ? await openApprovalChain(tx, 'WRITE_OFF', damageId, String(report.estimated_value))
        : [];

    await audit(tx, {
      entityType: ENTITY, entityId: damageId, action: 'TRANSITION',
      fromStatus: String(report.status), toStatus: 'DMG_DECISION_PENDING_APPROVAL',
      after: { decision, insurance_claim_ref: insuranceRef, levels: levels.length },
      userId: actor.principal.userId, ip: actor.ip,
      remarks:
        decision === 'WRITE_OFF'
          ? `Write-off of ₹${value.toLocaleString('en-IN')} proposed — ${levels.length} approval ${levels.length === 1 ? 'level' : 'levels'}`
          : `${decision.replace(/_/g, ' ').toLowerCase()} proposed`,
    });

    return { report: updated, levels: levels as unknown as Row[] };
  });
}

/** Where a decision lands once approved, and what it does to the stock. */
const OUTCOME: Record<DamageDecision, { status: string; movement: 'REPAIR_START' | 'WRITE_OFF' | null }> = {
  INTERNAL_REPAIR: { status: 'DMG_UNDER_REPAIR', movement: 'REPAIR_START' },
  WARRANTY_CLAIM: { status: 'DMG_RETURN_RAISED', movement: null },
  WRITE_OFF: { status: 'DMG_WRITTEN_OFF', movement: 'WRITE_OFF' },
};

/**
 * Approve the decision, and carry it out.
 *
 * A write-off decides one level of its chain at a time and only lands when the
 * last clears; the other two land on a single approval. Either way the stock
 * moves in the same transaction as the status:
 *
 *   INTERNAL_REPAIR  DAMAGED_HOLD → UNDER_REPAIR
 *   WRITE_OFF        DAMAGED_HOLD → WRITTEN_OFF
 *   WARRANTY_CLAIM   nothing yet — the stock stays quarantined until the
 *                    return that follows drains it, because until it physically
 *                    leaves it is still here.
 */
export async function approveDamageDecision(
  actor: Actor,
  damageId: number,
  approve = true,
  remarks?: string,
): Promise<{ report: Row; complete: boolean; entryId: number | null }> {
  return inTransaction(async tx => {
    const report = await loadDamage(tx, damageId, true);
    const siteId = Number(report.site_id);
    const decision = String(report.decision) as DamageDecision;

    if (!report.decision) {
      throw conflict('No decision has been proposed on this report yet.');
    }

    const outcome = OUTCOME[decision];

    // The person who proposed it does not approve it, whichever route it takes.
    if (Number(report.reported_by) === actor.principal.userId) {
      throw forbidden('You reported this damage, so somebody else approves what happens to it.');
    }

    let complete = true;

    if (decision === 'WRITE_OFF') {
      const result = await decide(tx, {
        entityType: 'WRITE_OFF',
        entityId: damageId,
        siteId,
        originatorId: Number(report.reported_by),
        principal: actor.principal,
        approve,
        remarks,
      });

      if (result.rejected) {
        // A refused write-off goes back to the inspectors, with the stock still
        // quarantined. Nothing is destroyed on a rejection.
        const [back] = await tx<Row[]>`
          UPDATE damage_reports
             SET status = 'DMG_INSPECTED', decision = NULL, updated_at = now()
           WHERE id = ${damageId} RETURNING *`;

        await audit(tx, {
          entityType: ENTITY, entityId: damageId, action: 'TRANSITION',
          fromStatus: String(report.status), toStatus: 'DMG_INSPECTED',
          userId: actor.principal.userId, ip: actor.ip,
          remarks: remarks?.trim() || 'Write-off refused; the stock stays quarantined',
        });

        return { report: back, complete: false, entryId: null };
      }

      complete = result.complete;
      if (!complete) {
        return { report, complete: false, entryId: null };
      }
    } else if (!approve) {
      throw badRequest('Only a write-off has an approval chain to reject. Propose a different decision instead.');
    }

    await assertTransition(
      {
        entityType: ENTITY, from: String(report.status), to: outcome.status,
        principal: actor.principal, siteId,
      },
      tx,
    );

    let entryId: number | null = null;

    if (outcome.movement) {
      entryId = await postMovement(tx, {
        siteId,
        itemId: Number(report.item_id),
        movement: outcome.movement,
        from: 'DAMAGED_HOLD',
        to: outcome.movement === 'REPAIR_START' ? 'UNDER_REPAIR' : 'WRITTEN_OFF',
        qty: String(report.qty),
        sourceType: 'DAMAGE_REPORT',
        sourceId: damageId,
        userId: actor.principal.userId,
        assetUnitId: report.asset_unit_id === null ? null : Number(report.asset_unit_id),
        unitValue: String(report.estimated_value),
        remarks: `${report.dmg_no}: ${decision.replace(/_/g, ' ').toLowerCase()}`,
      });
    }

    const [updated] = await tx<Row[]>`
      UPDATE damage_reports SET status = ${outcome.status}::damage_status, updated_at = now()
       WHERE id = ${damageId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: damageId, action: decision === 'WRITE_OFF' ? 'OVERRIDE' : 'TRANSITION',
      fromStatus: String(report.status), toStatus: outcome.status,
      after: { decision, entry_id: entryId },
      userId: actor.principal.userId, ip: actor.ip,
      remarks:
        decision === 'WARRANTY_CLAIM'
          ? 'Cleared to return — the stock stays quarantined until it leaves'
          : `${decision.replace(/_/g, ' ').toLowerCase()} approved`,
    });

    return { report: updated, complete: true, entryId };
  });
}

/**
 * The repair worked; the stock goes back on the shelf.
 *
 * UNDER_REPAIR → AVAILABLE, which is the only route by which quarantined stock
 * becomes issuable again. A repair that failed is not this — that report is
 * written off or returned instead.
 */
export async function completeRepair(actor: Actor, damageId: number, notes?: string): Promise<{ report: Row; entryId: number }> {
  return inTransaction(async tx => {
    const report = await loadDamage(tx, damageId, true);
    const siteId = Number(report.site_id);

    await assertTransition(
      { entityType: ENTITY, from: String(report.status), to: 'DMG_CLOSED', principal: actor.principal, siteId },
      tx,
    );

    if (String(report.status) !== 'DMG_UNDER_REPAIR') {
      throw conflict('Only stock that is under repair can come back from repair.');
    }

    const entryId = await postMovement(tx, {
      siteId,
      itemId: Number(report.item_id),
      movement: 'REPAIR_COMPLETE',
      from: 'UNDER_REPAIR',
      to: 'AVAILABLE',
      qty: String(report.qty),
      sourceType: 'DAMAGE_REPORT',
      sourceId: damageId,
      userId: actor.principal.userId,
      assetUnitId: report.asset_unit_id === null ? null : Number(report.asset_unit_id),
      remarks: `${report.dmg_no}: repaired and returned to stock`,
    });

    const [updated] = await tx<Row[]>`
      UPDATE damage_reports SET status = 'DMG_CLOSED', updated_at = now()
       WHERE id = ${damageId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: damageId, action: 'TRANSITION',
      fromStatus: String(report.status), toStatus: 'DMG_CLOSED',
      after: { entry_id: entryId },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: notes?.trim() || 'Repaired and back in stock',
    });

    return { report: updated, entryId };
  });
}

/** Close a report whose outcome has played out elsewhere — a return, or a write-off. */
export async function closeDamage(actor: Actor, damageId: number, remarks?: string): Promise<Row> {
  return inTransaction(async tx => {
    const current = await lockAndReadStatus(tx, 'damage_reports', damageId);
    if (!current) throw notFound('That damage report no longer exists.');

    await assertTransition(
      { entityType: ENTITY, from: current.status, to: 'DMG_CLOSED', principal: actor.principal, siteId: current.siteId },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE damage_reports SET status = 'DMG_CLOSED', updated_at = now()
       WHERE id = ${damageId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: damageId, action: 'TRANSITION',
      fromStatus: current.status, toStatus: 'DMG_CLOSED',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: remarks?.trim() || null,
    });

    return updated;
  });
}

/** The approval chain on a write-off, for the screen to render. */
export async function writeOffApprovals(damageId: number): Promise<Row[]> {
  return sql<Row[]>`
    SELECT a.*, u.full_name AS approver_name
      FROM approvals a LEFT JOIN app_users u ON u.id = a.approver_id
     WHERE a.entity_type = 'WRITE_OFF' AND a.entity_id = ${damageId}
     ORDER BY a.level_no`;
}

// =============================================================================
// Reads
// =============================================================================

export function listDamage(
  principal: Principal,
  filters: { status?: string; siteId?: number; inWarranty?: boolean } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT d.*, i.code AS item_code, i.name AS item_name, i.uom,
           s.code AS site_code, s.name AS site_name,
           l.code AS location_code, a.asset_tag,
           u.full_name AS reported_by_name,
           (SELECT count(*) FROM damage_inspections di WHERE di.damage_id = d.id) AS signature_count
      FROM damage_reports d
      JOIN items i ON i.id = d.item_id
      JOIN sites s ON s.id = d.site_id
      LEFT JOIN storage_locations l ON l.id = d.location_id
      LEFT JOIN asset_units a       ON a.id = d.asset_unit_id
      JOIN app_users u ON u.id = d.reported_by
     WHERE (${siteIds}::bigint[] IS NULL OR d.site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR d.status = ${filters.status ?? null}::damage_status)
       AND (${filters.siteId ?? null}::bigint IS NULL OR d.site_id = ${filters.siteId ?? null})
       AND (${filters.inWarranty ?? null}::boolean IS NULL OR d.in_warranty = ${filters.inWarranty ?? null})
     ORDER BY d.observed_on DESC, d.id DESC`;
}

export async function getDamage(id: number): Promise<{ report: Row; signatures: Row[] }> {
  const [report] = await sql<Row[]>`
    SELECT d.*, i.code AS item_code, i.name AS item_name, i.uom, i.is_serialised,
           s.code AS site_code, s.name AS site_name,
           l.code AS location_code, a.asset_tag, a.serial_no,
           u.full_name AS reported_by_name,
           g.grn_no, g.id AS grn_id, v.legal_name AS vendor_name,
           e.entry_no AS quarantine_entry_no
      FROM damage_reports d
      JOIN items i ON i.id = d.item_id
      JOIN sites s ON s.id = d.site_id
      LEFT JOIN storage_locations l ON l.id = d.location_id
      LEFT JOIN asset_units a       ON a.id = d.asset_unit_id
      JOIN app_users u ON u.id = d.reported_by
      LEFT JOIN grn_lines gl        ON gl.id = d.source_grn_line_id
      LEFT JOIN grns g              ON g.id = gl.grn_id
      LEFT JOIN purchase_orders po  ON po.id = g.po_id
      LEFT JOIN vendors v           ON v.id = po.vendor_id
      LEFT JOIN stock_ledger e      ON e.id = d.quarantine_entry_id
     WHERE d.id = ${id}`;

  if (!report) throw notFound('That damage report no longer exists.');

  const signatures = await sql<Row[]>`
    SELECT di.*, u.full_name AS inspector_name
      FROM damage_inspections di
      JOIN app_users u ON u.id = di.inspector_id
     WHERE di.damage_id = ${id}
     ORDER BY di.inspected_at`;

  return { report, signatures };
}
