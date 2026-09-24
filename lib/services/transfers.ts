/**
 * Inter-site stock transfer (brief §5).
 *
 * TRF_REQUESTED → TRF_APPROVED → TRF_DISPATCHED → TRF_RECEIVED
 *                ↘ TRF_REJECTED
 *
 * The decision belongs to the HOLDING site's Warehouse Lead, not the site
 * asking — they are the ones giving stock away. The prototype says so on the MR
 * screen: "Transfer requests go to the holding site's Warehouse Lead."
 *
 * Stock moves in three steps, each idempotent and each through
 * `post_stock_movement()`:
 *
 *   approve   AVAILABLE  → RESERVED    at the source — stops it being issued
 *   dispatch  RESERVED   → IN_TRANSIT  at the source — visible as in-transit
 *   receive   IN_TRANSIT → (nowhere)   at the source
 *             (nowhere)  → AVAILABLE   at the destination
 *
 * That last pair is two ledger rows against one transfer line, which the
 * supplied schema could not express — both would have collided on one
 * idempotency key. Amendment C-01 added `site_id` to the key so each leg is
 * distinct. Without it, stock arrived at the destination while the source held
 * it in IN_TRANSIT forever.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can, type Principal } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { normaliseText } from '@/lib/validate';
import {
  reserveForTransfer,
  dispatchTransfer,
  receiveTransfer,
  availableForUpdate,
} from '@/lib/services/stock';
import type { Actor, Row } from '@/lib/services/masters';

const ENTITY = 'TRANSFER';

async function loadTransfer(tx: Tx, id: number, lock = false): Promise<Row> {
  const rows = lock
    ? await tx<Row[]>`SELECT * FROM stock_transfers WHERE id = ${id} FOR UPDATE`
    : await tx<Row[]>`SELECT * FROM stock_transfers WHERE id = ${id}`;
  if (!rows[0]) throw notFound('That transfer no longer exists.');
  return rows[0];
}

// =============================================================================
// Request
// =============================================================================

export interface TransferInput {
  mrId?: number | null;
  fromSiteId: number;
  toSiteId: number;
  lines: { itemId: number; qty: string; mrLineId?: number | null }[];
}

/**
 * Raise a transfer request.
 *
 * `trf_sites_differ` refuses a transfer to the same site. Availability is
 * checked at request time as a courtesy — the real guard is the stock movement
 * on approval, which cannot overdraw.
 */
export async function requestTransfer(actor: Actor, input: TransferInput): Promise<Row> {
  if (!can(actor.principal, 'MR.REQUEST_TRANSFER', input.toSiteId)) {
    throw forbidden('You do not have permission to request a transfer to this site.');
  }

  if (input.fromSiteId === input.toSiteId) {
    throw badRequest('A transfer must move stock between two different sites.', 'to_site_id');
  }
  if (input.lines.length === 0) {
    throw badRequest('A transfer needs at least one line.', 'lines');
  }

  return inTransaction(async tx => {
    const transferNo = await nextDocumentNoForSite(tx, 'TRF', input.fromSiteId);

    const [transfer] = await tx<Row[]>`
      INSERT INTO stock_transfers (transfer_no, mr_id, from_site_id, to_site_id, status, requested_by)
      VALUES (${transferNo}, ${input.mrId ?? null}, ${input.fromSiteId}, ${input.toSiteId},
              'TRF_REQUESTED', ${actor.principal.userId})
      RETURNING *`;

    for (const line of input.lines) {
      if (Number(line.qty) <= 0) throw badRequest('Every transfer line needs a quantity above zero.', 'qty');

      const available = await availableForUpdate(tx, input.fromSiteId, line.itemId);
      if (available < Number(line.qty)) {
        const [item] = await tx<Row[]>`SELECT code FROM items WHERE id = ${line.itemId}`;
        throw badRequest(
          `The sending site has ${available} of ${item?.code ?? 'that item'} available, not ${line.qty}.`,
          'qty',
        );
      }

      await tx`
        INSERT INTO stock_transfer_lines (transfer_id, mr_line_id, item_id, qty)
        VALUES (${transfer.id as number}, ${line.mrLineId ?? null}, ${line.itemId}, ${line.qty}::numeric)`;
    }

    // Track it on the MR, where the request came from one.
    if (input.mrId) {
      const [mr] = await tx<Row[]>`SELECT status, site_id FROM material_requests WHERE id = ${input.mrId}`;
      if (mr) {
        await assertTransition(
          {
            entityType: 'MR',
            from: String(mr.status),
            to: 'MR_TRANSFER_REQUESTED',
            principal: actor.principal,
            siteId: Number(mr.site_id),
          },
          tx,
        );
        await tx`UPDATE material_requests SET status = 'MR_TRANSFER_REQUESTED' WHERE id = ${input.mrId}`;

        // The request moved with it; its own history has to say why (§29).
        await audit(tx, {
          entityType: 'MR', entityId: input.mrId, action: 'TRANSITION',
          fromStatus: String(mr.status), toStatus: 'MR_TRANSFER_REQUESTED',
          userId: actor.principal.userId, ip: actor.ip,
          remarks: `Transfer ${transfer.transfer_no} requested from the holding site`,
        });
      }
    }

    await audit(tx, {
      entityType: ENTITY, entityId: Number(transfer.id), action: 'CREATE',
      after: { transfer_no: transferNo, from: input.fromSiteId, to: input.toSiteId, lines: input.lines.length },
      userId: actor.principal.userId, ip: actor.ip,
    });

    return transfer;
  });
}

// =============================================================================
// Decide
// =============================================================================

/**
 * Approve or reject, as the holding site.
 *
 * Permission is checked against `from_site_id` — the site giving the stock up.
 * Approval reserves it, so it can no longer be issued locally while the
 * transfer is in flight.
 */
export async function decideTransfer(
  actor: Actor,
  transferId: number,
  approve: boolean,
  reason?: string,
): Promise<Row> {
  return inTransaction(async tx => {
    const transfer = await loadTransfer(tx, transferId, true);
    const fromSiteId = Number(transfer.from_site_id);

    if (!can(actor.principal, 'TRANSFER.DECIDE', fromSiteId)) {
      const [site] = await tx<Row[]>`SELECT code, name FROM sites WHERE id = ${fromSiteId}`;
      throw forbidden(
        `This transfer is decided by the Warehouse Lead at ${site?.name ?? 'the holding site'}, which you are not.`,
      );
    }

    if (Number(transfer.requested_by) === actor.principal.userId) {
      throw forbidden('You raised this transfer, so the holding site must decide it.');
    }

    const to = approve ? 'TRF_APPROVED' : 'TRF_REJECTED';
    await assertTransition(
      { entityType: ENTITY, from: String(transfer.status), to, principal: actor.principal, siteId: fromSiteId },
      tx,
    );

    const text = reason?.trim() || null;
    if (!approve && !text) throw badRequest('Rejecting a transfer requires a reason.', 'rejection_reason');

    if (approve) {
      const lines = await tx<Row[]>`SELECT * FROM stock_transfer_lines WHERE transfer_id = ${transferId}`;
      for (const line of lines) {
        await reserveForTransfer(tx, {
          siteId: fromSiteId,
          itemId: Number(line.item_id),
          qty: String(line.qty),
          transferLineId: Number(line.id),
          userId: actor.principal.userId,
        });
      }
    }

    const [updated] = await tx<Row[]>`
      UPDATE stock_transfers
         SET status = ${to}::transfer_status, decided_by = ${actor.principal.userId},
             decided_at = now(), rejection_reason = ${text}
       WHERE id = ${transferId}
      RETURNING *`;

    if (transfer.mr_id) {
      const [mr] = await tx<Row[]>`SELECT status, site_id FROM material_requests WHERE id = ${transfer.mr_id as number}`;
      const mrTo = approve ? 'MR_TRANSFER_APPROVED' : 'MR_TRANSFER_REJECTED';
      if (mr && mr.status === 'MR_TRANSFER_REQUESTED') {
        await tx`UPDATE material_requests SET status = ${mrTo}::mr_status WHERE id = ${transfer.mr_id as number}`;

        await audit(tx, {
          entityType: 'MR', entityId: Number(transfer.mr_id), action: 'TRANSITION',
          fromStatus: String(mr.status), toStatus: mrTo,
          userId: actor.principal.userId, ip: actor.ip,
          remarks: `Transfer ${transfer.transfer_no} ${approve ? 'approved' : 'rejected'} by the holding site`,
        });
      }
    }

    await audit(tx, {
      entityType: ENTITY, entityId: transferId, action: 'TRANSITION',
      fromStatus: String(transfer.status), toStatus: to,
      userId: actor.principal.userId, ip: actor.ip,
      remarks: text ?? (approve ? 'Approved; stock reserved at the holding site' : null),
    });

    return updated;
  });
}

/** Dispatch: RESERVED → IN_TRANSIT at the source. */
export async function dispatchTransferOrder(actor: Actor, transferId: number): Promise<Row> {
  return inTransaction(async tx => {
    const transfer = await loadTransfer(tx, transferId, true);
    const fromSiteId = Number(transfer.from_site_id);

    await assertTransition(
      {
        entityType: ENTITY,
        from: String(transfer.status),
        to: 'TRF_DISPATCHED',
        principal: actor.principal,
        siteId: fromSiteId,
      },
      tx,
    );

    const lines = await tx<Row[]>`SELECT * FROM stock_transfer_lines WHERE transfer_id = ${transferId}`;
    for (const line of lines) {
      await dispatchTransfer(tx, {
        siteId: fromSiteId,
        itemId: Number(line.item_id),
        qty: String(line.qty),
        transferLineId: Number(line.id),
        userId: actor.principal.userId,
      });
    }

    const [updated] = await tx<Row[]>`
      UPDATE stock_transfers SET status = 'TRF_DISPATCHED', dispatched_at = now()
       WHERE id = ${transferId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: transferId, action: 'TRANSITION',
      fromStatus: String(transfer.status), toStatus: 'TRF_DISPATCHED',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: 'Dispatched; stock now in transit',
    });

    return updated;
  });
}

/**
 * Receive at the destination.
 *
 * Posts BOTH legs — draining IN_TRANSIT at the source and crediting AVAILABLE
 * at the destination. See the note at the top of this file: this is the case
 * amendment C-01 exists for.
 *
 * A short receipt is recorded as what actually arrived; the difference stays
 * in transit for a damage report or an adjustment to resolve, rather than being
 * silently written off (brief §35).
 */
export async function receiveTransferOrder(
  actor: Actor,
  transferId: number,
  received?: { transferLineId: number; qtyReceived: string }[],
): Promise<Row> {
  return inTransaction(async tx => {
    const transfer = await loadTransfer(tx, transferId, true);
    const fromSiteId = Number(transfer.from_site_id);
    const toSiteId = Number(transfer.to_site_id);

    await assertTransition(
      {
        entityType: ENTITY,
        from: String(transfer.status),
        to: 'TRF_RECEIVED',
        principal: actor.principal,
        siteId: toSiteId,
      },
      tx,
    );

    const lines = await tx<Row[]>`SELECT * FROM stock_transfer_lines WHERE transfer_id = ${transferId}`;
    const counts = new Map((received ?? []).map(r => [r.transferLineId, r.qtyReceived]));
    const shortLines: string[] = [];

    for (const line of lines) {
      const dispatched = String(line.qty);
      const qty = counts.get(Number(line.id)) ?? dispatched;

      if (Number(qty) > Number(dispatched)) {
        throw badRequest(`More cannot be received than was dispatched (${dispatched}).`, 'qty_received');
      }
      if (Number(qty) < Number(dispatched)) shortLines.push(`line ${line.id}: ${qty} of ${dispatched}`);

      if (Number(qty) > 0) {
        await receiveTransfer(tx, {
          fromSiteId,
          toSiteId,
          itemId: Number(line.item_id),
          qty,
          transferLineId: Number(line.id),
          userId: actor.principal.userId,
        });
      }

      await tx`UPDATE stock_transfer_lines SET qty_received = ${qty}::numeric WHERE id = ${line.id as number}`;
    }

    const [updated] = await tx<Row[]>`
      UPDATE stock_transfers
         SET status = 'TRF_RECEIVED', received_by = ${actor.principal.userId}, received_at = now()
       WHERE id = ${transferId}
      RETURNING *`;

    // An MR met entirely by transfer is finished here.
    if (transfer.mr_id) {
      const [mr] = await tx<Row[]>`
        SELECT m.status, m.site_id,
               (SELECT coalesce(sum(qty_purchase), 0) FROM mr_lines WHERE mr_id = m.id) AS to_purchase
          FROM material_requests m WHERE m.id = ${transfer.mr_id as number} FOR UPDATE`;

      if (mr && Number(mr.to_purchase) === 0 && mr.status === 'MR_TRANSFER_APPROVED') {
        await tx`UPDATE material_requests SET status = 'MR_FULFILLED_INTERNAL' WHERE id = ${transfer.mr_id as number}`;

        await audit(tx, {
          entityType: 'MR', entityId: Number(transfer.mr_id), action: 'TRANSITION',
          fromStatus: 'MR_TRANSFER_APPROVED', toStatus: 'MR_FULFILLED_INTERNAL',
          userId: actor.principal.userId, ip: actor.ip,
          remarks: `Transfer ${transfer.transfer_no} received in full`,
        });
      }
    }

    await audit(tx, {
      entityType: ENTITY, entityId: transferId, action: 'TRANSITION',
      fromStatus: String(transfer.status), toStatus: 'TRF_RECEIVED',
      userId: actor.principal.userId, ip: actor.ip,
      remarks: shortLines.length > 0 ? `Received short — ${shortLines.join('; ')}` : 'Received in full',
    });

    return updated;
  });
}

export async function cancelTransfer(actor: Actor, transferId: number, reason: string): Promise<Row> {
  return inTransaction(async tx => {
    const transfer = await loadTransfer(tx, transferId, true);

    await assertTransition(
      {
        entityType: ENTITY,
        from: String(transfer.status),
        to: 'TRF_CANCELLED',
        principal: actor.principal,
        siteId: Number(transfer.from_site_id),
      },
      tx,
    );

    const text = normaliseText(reason ?? '');
    if (!text) throw badRequest('Cancelling a transfer requires a reason.', 'reason');

    // Reserved stock has to go back, or it is stranded. Only a transfer that
    // has not yet dispatched can be cancelled, so RESERVED is the only state to
    // unwind — the transition table enforces that.
    if (transfer.status === 'TRF_APPROVED') {
      throw conflict(
        'This transfer has already reserved stock. Reject it before approval, or dispatch and return it as a separate transfer.',
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE stock_transfers SET status = 'TRF_CANCELLED', rejection_reason = ${text}
       WHERE id = ${transferId} RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: transferId, action: 'TRANSITION',
      fromStatus: String(transfer.status), toStatus: 'TRF_CANCELLED',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listTransfers(
  principal: Principal,
  filters: { status?: string; direction?: 'in' | 'out' } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT t.*, f.code AS from_code, f.name AS from_name, d.code AS to_code, d.name AS to_name,
           m.mr_no, u.full_name AS requested_by_name,
           (SELECT count(*) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS line_count
      FROM stock_transfers t
      JOIN sites f     ON f.id = t.from_site_id
      JOIN sites d     ON d.id = t.to_site_id
      JOIN app_users u ON u.id = t.requested_by
      LEFT JOIN material_requests m ON m.id = t.mr_id
     WHERE (${siteIds}::bigint[] IS NULL
            OR t.from_site_id = ANY(${siteIds}) OR t.to_site_id = ANY(${siteIds}))
       AND (${filters.status ?? null}::text IS NULL OR t.status = ${filters.status ?? null}::transfer_status)
       AND (${filters.direction ?? null}::text IS NULL
            OR (${filters.direction ?? null} = 'out' AND (${siteIds}::bigint[] IS NULL OR t.from_site_id = ANY(${siteIds})))
            OR (${filters.direction ?? null} = 'in'  AND (${siteIds}::bigint[] IS NULL OR t.to_site_id   = ANY(${siteIds}))))
     ORDER BY t.created_at DESC`;
}

export async function getTransfer(id: number): Promise<{ transfer: Row; lines: Row[] }> {
  const [transfer] = await sql<Row[]>`
    SELECT t.*, f.code AS from_code, f.name AS from_name, d.code AS to_code, d.name AS to_name,
           m.mr_no, u.full_name AS requested_by_name, dec.full_name AS decided_by_name,
           rec.full_name AS received_by_name
      FROM stock_transfers t
      JOIN sites f     ON f.id = t.from_site_id
      JOIN sites d     ON d.id = t.to_site_id
      JOIN app_users u ON u.id = t.requested_by
      LEFT JOIN app_users dec ON dec.id = t.decided_by
      LEFT JOIN app_users rec ON rec.id = t.received_by
      LEFT JOIN material_requests m ON m.id = t.mr_id
     WHERE t.id = ${id}`;

  if (!transfer) throw notFound('That transfer no longer exists.');

  const lines = await sql<Row[]>`
    SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom
      FROM stock_transfer_lines l JOIN items i ON i.id = l.item_id
     WHERE l.transfer_id = ${id} ORDER BY l.id`;

  return { transfer, lines };
}
