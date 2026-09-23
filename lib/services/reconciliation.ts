/**
 * Vendor reconciliation (brief §23).
 *
 * RECON_OPEN → RECON_DIFFERENCE → RECON_RECONCILED → RECON_CONFIRMED_BY_VENDOR
 *            ↘ RECON_RECONCILED ↗                  ↘ RECON_DIFFERENCE (reopen)
 *
 * A run compares two ledgers that were written independently: PORTAL, which
 * this application maintains as invoices and debit notes are recorded, and
 * TALLY, which is imported from the accounts system. Neither is adjusted to
 * agree with the other — that would defeat the exercise.
 *
 * `recon_zero_to_close` is the constraint that matters:
 *
 *   CHECK (status NOT IN ('RECON_RECONCILED', 'RECON_CONFIRMED_BY_VENDOR')
 *          OR portal_balance = tally_balance)
 *
 * A run cannot be closed while the two sides differ. Not "should not" — cannot.
 * The balances are stored on the run as at the moment it was taken, so closing
 * means going back and fixing whichever side was wrong, then taking a fresh
 * run. There is no route by which a difference is closed away.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { assertTransition } from '@/lib/transitions';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { balance, postLedger, type LedgerDocType } from '@/lib/services/ledger-accounts';
import { normaliseText } from '@/lib/validate';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'RECON';

/** Two money figures agree below this. */
const PAISA = 0.01;

function requirePermission(actor: Actor, key: Parameters<typeof can>[1]) {
  // Reconciliation is a vendor-level activity, not a site one — a vendor
  // account spans every site that ordered from them.
  if (!can(actor.principal, key, null)) {
    throw forbidden('You do not have permission to do that with reconciliation.');
  }
}

// =============================================================================
// Importing the Tally side
// =============================================================================

export interface TallyEntry {
  entryDate: string;
  docType: LedgerDocType;
  docRef: string;
  amount: string;
  tallyVoucherRef?: string | null;
}

/**
 * Import ledger rows from the accounts system.
 *
 * Deliberately dumb: the figures are written exactly as supplied. An import
 * that rounded, netted or corrected anything on the way in would hide the very
 * discrepancy it exists to surface — and the first thing anyone would ask of a
 * reconciliation that always balanced is whether it was doing anything.
 *
 * Re-importing the same voucher is skipped rather than duplicated, so a
 * re-uploaded file is safe.
 */
export async function importTally(
  actor: Actor,
  vendorId: number,
  rows: TallyEntry[],
): Promise<{ imported: number; skipped: number }> {
  requirePermission(actor, 'RECON.IMPORT_TALLY');

  if (rows.length === 0) throw badRequest('There is nothing to import.', 'entries');

  return inTransaction(async tx => {
    const [vendor] = await tx<Row[]>`SELECT legal_name FROM vendors WHERE id = ${vendorId}`;
    if (!vendor) throw notFound('That vendor no longer exists.');

    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      const ref = normaliseText(row.docRef);
      const voucher = row.tallyVoucherRef?.trim() || null;

      const [existing] = await tx<Row[]>`
        SELECT id FROM vendor_ledger_entries
         WHERE vendor_id = ${vendorId} AND side = 'TALLY'
           AND entry_date = ${row.entryDate}::date
           AND doc_ref = ${ref}
           AND amount = ${row.amount}::numeric`;

      if (existing) {
        skipped++;
        continue;
      }

      await postLedger(tx, {
        vendorId,
        side: 'TALLY',
        entryDate: row.entryDate,
        docType: row.docType,
        docRef: ref,
        amount: row.amount,
        tallyVoucherRef: voucher,
      });
      imported++;
    }

    await audit(tx, {
      entityType: ENTITY, entityId: vendorId, action: 'CREATE',
      after: { imported, skipped, vendor: vendor.legal_name },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Tally import: ${imported} added, ${skipped} already present`,
    });

    return { imported, skipped };
  });
}

// =============================================================================
// Running a reconciliation
// =============================================================================

/**
 * Match the two sides.
 *
 * Matching is on (date, reference, amount) first, then on (reference, amount)
 * to catch a posting-date difference, which is by far the most common reason
 * two correct ledgers disagree. Anything unmatched is reported as sitting on
 * one side only — which is the actual finding, not a failure of the matcher.
 */
async function matchSides(tx: Tx, vendorId: number, from: string, to: string) {
  const portal = await tx<Row[]>`
    SELECT * FROM vendor_ledger_entries
     WHERE vendor_id = ${vendorId} AND side = 'PORTAL'
       AND entry_date BETWEEN ${from}::date AND ${to}::date
     ORDER BY entry_date, id`;

  const tally = await tx<Row[]>`
    SELECT * FROM vendor_ledger_entries
     WHERE vendor_id = ${vendorId} AND side = 'TALLY'
       AND entry_date BETWEEN ${from}::date AND ${to}::date
     ORDER BY entry_date, id`;

  const usedTally = new Set<number>();
  const items: { portalId: number | null; tallyId: number | null; status: string; note: string | null }[] = [];

  const ref = (r: Row) => normaliseText(String(r.doc_ref)).toUpperCase();

  for (const p of portal) {
    // Exact first: same day, same reference, same amount.
    let hit = tally.find(
      t =>
        !usedTally.has(Number(t.id)) &&
        ref(t) === ref(p) &&
        Math.abs(Number(t.amount) - Number(p.amount)) < PAISA &&
        String(t.entry_date) === String(p.entry_date),
    );
    let status = 'MATCHED';
    let note: string | null = null;

    if (!hit) {
      // Same reference and amount, different date — a posting-date difference,
      // not a discrepancy in what is owed.
      hit = tally.find(
        t =>
          !usedTally.has(Number(t.id)) &&
          ref(t) === ref(p) &&
          Math.abs(Number(t.amount) - Number(p.amount)) < PAISA,
      );
      if (hit) note = `Posted ${p.entry_date} here, ${hit.entry_date} in Tally`;
    }

    if (!hit) {
      // Same reference, different amount — this one IS a discrepancy.
      hit = tally.find(t => !usedTally.has(Number(t.id)) && ref(t) === ref(p));
      if (hit) {
        status = 'AMOUNT_DIFFERS';
        note = `₹${p.amount} here against ₹${hit.amount} in Tally`;
      }
    }

    if (hit) {
      usedTally.add(Number(hit.id));
      items.push({ portalId: Number(p.id), tallyId: Number(hit.id), status, note });
    } else {
      items.push({
        portalId: Number(p.id), tallyId: null, status: 'ONLY_IN_PORTAL',
        note: `${p.doc_type} ${p.doc_ref} has not reached Tally`,
      });
    }
  }

  for (const t of tally) {
    if (usedTally.has(Number(t.id))) continue;
    items.push({
      portalId: null, tallyId: Number(t.id), status: 'ONLY_IN_TALLY',
      note: `${t.doc_type} ${t.doc_ref} is not in the portal`,
    });
  }

  return items;
}

/**
 * Take a reconciliation for a vendor over a period.
 *
 * Balances are as at the period end and are stored on the run, so a run is a
 * snapshot rather than a live view. Re-running the same period replaces the
 * items but keeps the run — `vendor_recon_runs` is unique on
 * (vendor, period start, period end), and a second run of the same month is the
 * same exercise repeated, not a different one.
 */
export async function runReconciliation(
  actor: Actor,
  input: { vendorId: number; periodStart: string; periodEnd: string },
): Promise<{ run: Row; items: Row[] }> {
  requirePermission(actor, 'RECON.RUN');

  return inTransaction(async tx => {
    const [vendor] = await tx<Row[]>`SELECT legal_name FROM vendors WHERE id = ${input.vendorId}`;
    if (!vendor) throw notFound('That vendor no longer exists.');

    if (input.periodEnd < input.periodStart) {
      throw badRequest('The period ends before it starts.', 'period_end');
    }

    const portalBalance = await balance(tx, input.vendorId, 'PORTAL', input.periodEnd);
    const tallyBalance = await balance(tx, input.vendorId, 'TALLY', input.periodEnd);

    // Whatever is being withheld on open invoices explains part of a gap, so it
    // is carried on the run rather than left to be rediscovered each time.
    const [held] = await tx<{ held: string }[]>`
      SELECT coalesce(sum(i.held_amount), 0)::text AS held
        FROM vendor_invoices i
       WHERE i.vendor_id = ${input.vendorId} AND i.status <> 'INV_PAID'`;

    const differs = Math.abs(Number(portalBalance) - Number(tallyBalance)) >= PAISA;

    const [existing] = await tx<Row[]>`
      SELECT * FROM vendor_recon_runs
       WHERE vendor_id = ${input.vendorId}
         AND period_start = ${input.periodStart}::date
         AND period_end = ${input.periodEnd}::date
       FOR UPDATE`;

    if (existing && ['RECON_RECONCILED', 'RECON_CONFIRMED_BY_VENDOR'].includes(String(existing.status))) {
      throw conflict(
        `${vendor.legal_name} is already reconciled for that period. Reopen the run before taking it again.`,
      );
    }

    const run = existing
      ? (
          await tx<Row[]>`
            UPDATE vendor_recon_runs
               SET portal_balance = ${portalBalance}::numeric,
                   tally_balance  = ${tallyBalance}::numeric,
                   held_amount    = ${held.held}::numeric,
                   status = ${differs ? 'RECON_DIFFERENCE' : 'RECON_OPEN'}::recon_status
             WHERE id = ${existing.id as number}
            RETURNING *`
        )[0]
      : (
          await tx<Row[]>`
            INSERT INTO vendor_recon_runs (vendor_id, period_start, period_end, portal_balance,
                                           tally_balance, held_amount, status)
            VALUES (${input.vendorId}, ${input.periodStart}::date, ${input.periodEnd}::date,
                    ${portalBalance}::numeric, ${tallyBalance}::numeric, ${held.held}::numeric,
                    ${differs ? 'RECON_DIFFERENCE' : 'RECON_OPEN'}::recon_status)
            RETURNING *`
        )[0];

    // A re-run replaces its items; the findings are about the ledgers as they
    // are now, not as they were when the run was first taken.
    await tx`DELETE FROM vendor_recon_items WHERE run_id = ${run.id as number}`;

    const matched = await matchSides(tx, input.vendorId, input.periodStart, input.periodEnd);

    for (const item of matched) {
      await tx`
        INSERT INTO vendor_recon_items (run_id, portal_entry_id, tally_entry_id, match_status, note)
        VALUES (${run.id as number}, ${item.portalId}, ${item.tallyId},
                ${item.status}::recon_match, ${item.note})`;
    }

    // Read the items back through the TRANSACTION, not the pool. Using the
    // global client here would read pre-transaction state and hand back the
    // previous run's findings, which is both wrong and very hard to spot —
    // the run row would be right and only its items stale.
    const items = await reconItemsIn(tx, Number(run.id));

    await audit(tx, {
      entityType: ENTITY, entityId: Number(run.id), action: existing ? 'UPDATE' : 'CREATE',
      after: {
        vendor: vendor.legal_name, portal: portalBalance, tally: tallyBalance,
        difference: run.difference, items: matched.length,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: differs
        ? `Difference of ₹${run.difference} over ${input.periodStart} to ${input.periodEnd}`
        : `Balanced over ${input.periodStart} to ${input.periodEnd}`,
    });

    return { run, items };
  });
}

/** Note what was done about one unmatched item. */
export async function resolveItem(actor: Actor, itemId: number, note: string): Promise<Row> {
  const text = note?.trim();
  if (!text || text.length < 4) {
    throw badRequest('Say what was done about it — that note is the whole value of resolving it.', 'note');
  }

  return inTransaction(async tx => {
    requirePermission(actor, 'RECON.RESOLVE');

    const [item] = await tx<Row[]>`
      SELECT i.*, r.vendor_id FROM vendor_recon_items i
        JOIN vendor_recon_runs r ON r.id = i.run_id
       WHERE i.id = ${itemId} FOR UPDATE OF i`;
    if (!item) throw notFound('That reconciliation item no longer exists.');

    const [updated] = await tx<Row[]>`
      UPDATE vendor_recon_items
         SET note = ${text}, resolved_by = ${actor.principal.userId}, resolved_at = now()
       WHERE id = ${itemId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: Number(item.run_id), action: 'UPDATE',
      after: { item: itemId, match_status: item.match_status, note: text },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Resolved a ${String(item.match_status).replace(/_/g, ' ').toLowerCase()} item`,
    });

    return updated;
  });
}

/**
 * Close the run.
 *
 * `recon_zero_to_close` refuses this while the two sides differ, and that is
 * checked here first so the refusal explains itself. There is no override: a
 * difference is closed by correcting whichever ledger is wrong and taking the
 * run again, not by agreeing to ignore it.
 */
export async function closeReconciliation(actor: Actor, runId: number, remarks?: string): Promise<Row> {
  return inTransaction(async tx => {
    const [run] = await tx<Row[]>`
      SELECT r.*, v.legal_name AS vendor_name FROM vendor_recon_runs r
        JOIN vendors v ON v.id = r.vendor_id
       WHERE r.id = ${runId} FOR UPDATE OF r`;
    if (!run) throw notFound('That reconciliation run no longer exists.');

    await assertTransition(
      {
        entityType: ENTITY, from: String(run.status), to: 'RECON_RECONCILED',
        principal: actor.principal, siteId: null,
      },
      tx,
    );

    if (Math.abs(Number(run.difference)) >= PAISA) {
      const openItems = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM vendor_recon_items
         WHERE run_id = ${runId} AND match_status <> 'MATCHED' AND resolved_at IS NULL`;

      throw conflict(
        `${run.vendor_name} is out by ₹${run.difference} — the portal says ₹${run.portal_balance} and Tally says ₹${run.tally_balance}. ${openItems[0].n} item${openItems[0].n === '1' ? '' : 's'} remain unresolved. Correct whichever side is wrong and run it again; a difference cannot be closed away.`,
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE vendor_recon_runs
         SET status = 'RECON_RECONCILED', reconciled_by = ${actor.principal.userId}, reconciled_at = now()
       WHERE id = ${runId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: runId, action: 'TRANSITION',
      fromStatus: String(run.status), toStatus: 'RECON_RECONCILED',
      after: { portal: run.portal_balance, tally: run.tally_balance },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: remarks?.trim() || `Balanced at ₹${run.portal_balance}`,
    });

    return updated;
  });
}

/** The vendor agrees with the balance, and says so with their own figure. */
export async function confirmReconciliation(
  actor: Actor,
  runId: number,
  confirmedBalance: string,
): Promise<Row> {
  const confirmed = Number(confirmedBalance);
  if (!Number.isFinite(confirmed)) {
    throw badRequest('Record the balance the vendor confirmed.', 'vendor_confirmed_balance');
  }

  return inTransaction(async tx => {
    const [run] = await tx<Row[]>`SELECT * FROM vendor_recon_runs WHERE id = ${runId} FOR UPDATE`;
    if (!run) throw notFound('That reconciliation run no longer exists.');

    await assertTransition(
      {
        entityType: ENTITY, from: String(run.status), to: 'RECON_CONFIRMED_BY_VENDOR',
        principal: actor.principal, siteId: null,
      },
      tx,
    );

    // A confirmation that disagrees with the closed balance is not a
    // confirmation — it is a new difference, and recording it as agreement
    // would bury it.
    if (Math.abs(confirmed - Number(run.portal_balance)) >= PAISA) {
      throw conflict(
        `The vendor confirms ₹${confirmed.toFixed(2)}, but this run closed at ₹${run.portal_balance}. That is a fresh difference — reopen the run rather than recording it as agreed.`,
      );
    }

    const [updated] = await tx<Row[]>`
      UPDATE vendor_recon_runs
         SET status = 'RECON_CONFIRMED_BY_VENDOR', vendor_confirmed_balance = ${confirmed.toFixed(2)}::numeric
       WHERE id = ${runId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: runId, action: 'TRANSITION',
      fromStatus: String(run.status), toStatus: 'RECON_CONFIRMED_BY_VENDOR',
      after: { vendor_confirmed_balance: confirmed.toFixed(2) },
      userId: actor.principal.userId, ip: actor.ip,
    });

    return updated;
  });
}

/** Reopen a closed run — a Functional Head's call, because it undoes a sign-off. */
export async function reopenReconciliation(actor: Actor, runId: number, reason: string): Promise<Row> {
  const text = reason?.trim();
  if (!text || text.length < 4) throw badRequest('Reopening a closed run needs a reason.', 'reason');

  return inTransaction(async tx => {
    const [run] = await tx<Row[]>`SELECT * FROM vendor_recon_runs WHERE id = ${runId} FOR UPDATE`;
    if (!run) throw notFound('That reconciliation run no longer exists.');

    await assertTransition(
      {
        entityType: ENTITY, from: String(run.status), to: 'RECON_DIFFERENCE',
        principal: actor.principal, siteId: null,
      },
      tx,
    );

    const [updated] = await tx<Row[]>`
      UPDATE vendor_recon_runs
         SET status = 'RECON_DIFFERENCE', reconciled_by = NULL, reconciled_at = NULL
       WHERE id = ${runId}
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: runId, action: 'OVERRIDE',
      fromStatus: String(run.status), toStatus: 'RECON_DIFFERENCE',
      userId: actor.principal.userId, ip: actor.ip, remarks: text,
    });

    return updated;
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listRuns(
  principal: Principal,
  filters: { vendorId?: number; status?: string } = {},
): Promise<Row[]> {
  void principal; // vendor accounts are group-level; RECON.VIEW is the gate
  return sql<Row[]>`
    SELECT r.*, v.legal_name AS vendor_name, v.vendor_code,
           u.full_name AS reconciled_by_name,
           (SELECT count(*) FROM vendor_recon_items i
             WHERE i.run_id = r.id AND i.match_status <> 'MATCHED') AS unmatched,
           (SELECT count(*) FROM vendor_recon_items i
             WHERE i.run_id = r.id AND i.match_status <> 'MATCHED' AND i.resolved_at IS NULL) AS unresolved
      FROM vendor_recon_runs r
      JOIN vendors v        ON v.id = r.vendor_id
      LEFT JOIN app_users u ON u.id = r.reconciled_by
     WHERE (${filters.vendorId ?? null}::bigint IS NULL OR r.vendor_id = ${filters.vendorId ?? null})
       AND (${filters.status ?? null}::text IS NULL OR r.status = ${filters.status ?? null}::recon_status)
     ORDER BY r.period_end DESC, v.legal_name`;
}

export function reconItems(runId: number): Promise<Row[]> {
  return reconItemsIn(sql, runId);
}

/** As `reconItems`, but on a caller-supplied runner so it can join a transaction. */
function reconItemsIn(runner: typeof sql | Tx, runId: number): Promise<Row[]> {
  return runner<Row[]>`
    SELECT i.*,
           p.entry_date AS portal_date, p.doc_type AS portal_doc_type,
           p.doc_ref AS portal_ref, p.amount AS portal_amount,
           t.entry_date AS tally_date, t.doc_type AS tally_doc_type,
           t.doc_ref AS tally_ref, t.amount AS tally_amount,
           u.full_name AS resolved_by_name
      FROM vendor_recon_items i
      LEFT JOIN vendor_ledger_entries p ON p.id = i.portal_entry_id
      LEFT JOIN vendor_ledger_entries t ON t.id = i.tally_entry_id
      LEFT JOIN app_users u             ON u.id = i.resolved_by
     WHERE i.run_id = ${runId}
     ORDER BY
       CASE i.match_status WHEN 'MATCHED' THEN 2 ELSE 1 END,
       coalesce(p.entry_date, t.entry_date), i.id`;
}

export async function getRun(runId: number): Promise<{ run: Row; items: Row[] }> {
  const [run] = await sql<Row[]>`
    SELECT r.*, v.legal_name AS vendor_name, v.vendor_code, v.id AS vendor_id,
           u.full_name AS reconciled_by_name
      FROM vendor_recon_runs r
      JOIN vendors v        ON v.id = r.vendor_id
      LEFT JOIN app_users u ON u.id = r.reconciled_by
     WHERE r.id = ${runId}`;

  if (!run) throw notFound('That reconciliation run no longer exists.');

  return { run, items: await reconItems(runId) };
}
