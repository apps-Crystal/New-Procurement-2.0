/**
 * The vendor ledger — both sides of it.
 *
 * `vendor_ledger_entries.side` is either PORTAL or TALLY, and the two are kept
 * deliberately separate rather than merged. That separation is the entire point
 * of reconciliation: if the app wrote both sides there would be nothing to
 * reconcile, only a report of what the app already believed.
 *
 * PORTAL rows are written here, by the app, as invoices and debit notes are
 * recorded. TALLY rows are imported from the accounts system and are never
 * computed — an imported figure that the app adjusted on the way in would hide
 * exactly the discrepancy the import exists to surface.
 *
 * Sign convention, from the schema's own comment on `amount`:
 *
 *   +  raises the payable (Cr) — an invoice
 *   −  reduces it      (Dr) — a payment, a debit note, a credit note
 */
import { sql, type Tx } from '@/lib/db';
import type { Row } from '@/lib/services/masters';

export type LedgerSide = 'PORTAL' | 'TALLY';
export type LedgerDocType = 'OPENING' | 'INVOICE' | 'PAYMENT' | 'ADVANCE' | 'DEBIT_NOTE' | 'CREDIT_NOTE';

export interface LedgerEntry {
  vendorId: number;
  side: LedgerSide;
  entryDate: string;
  docType: LedgerDocType;
  docRef: string;
  /** Signed: positive raises the payable, negative reduces it. */
  amount: string;
  poId?: number | null;
  sourceTable?: string | null;
  sourceId?: number | null;
  tallyVoucherRef?: string | null;
}

/**
 * Write one ledger row.
 *
 * Runs inside the caller's transaction, so the ledger entry and the document it
 * describes commit together. There is no "post the ledger later" path, because
 * a ledger that lags its documents is a ledger nobody can trust at a moment in
 * time — which is the only moment reconciliation cares about.
 */
export async function postLedger(tx: Tx, entry: LedgerEntry): Promise<number> {
  const [row] = await tx<Row[]>`
    INSERT INTO vendor_ledger_entries (vendor_id, side, entry_date, doc_type, doc_ref, amount,
                                       po_id, source_table, source_id, tally_voucher_ref, imported_at)
    VALUES (${entry.vendorId}, ${entry.side}::ledger_side, ${entry.entryDate}::date,
            ${entry.docType}, ${entry.docRef}, ${entry.amount}::numeric,
            ${entry.poId ?? null}, ${entry.sourceTable ?? null}, ${entry.sourceId ?? null},
            ${entry.tallyVoucherRef ?? null},
            ${entry.side === 'TALLY' ? sql`now()` : null})
    RETURNING id`;

  return Number(row.id);
}

/** Balance on one side, as at a date. */
export async function balance(
  tx: Tx,
  vendorId: number,
  side: LedgerSide,
  asAt?: string,
): Promise<string> {
  const [row] = await tx<{ balance: string }[]>`
    SELECT coalesce(sum(amount), 0)::text AS balance
      FROM vendor_ledger_entries
     WHERE vendor_id = ${vendorId} AND side = ${side}::ledger_side
       AND (${asAt ?? null}::date IS NULL OR entry_date <= ${asAt ?? null}::date)`;

  return row.balance;
}

/** Entries on one side over a period, oldest first. */
export function entries(
  vendorId: number,
  side: LedgerSide,
  from?: string,
  to?: string,
): Promise<Row[]> {
  return sql<Row[]>`
    SELECT e.*, po.po_no
      FROM vendor_ledger_entries e
      LEFT JOIN purchase_orders po ON po.id = e.po_id
     WHERE e.vendor_id = ${vendorId} AND e.side = ${side}::ledger_side
       AND (${from ?? null}::date IS NULL OR e.entry_date >= ${from ?? null}::date)
       AND (${to ?? null}::date IS NULL OR e.entry_date <= ${to ?? null}::date)
     ORDER BY e.entry_date, e.id`;
}

/** Both sides at once, for a statement screen. */
export async function statement(
  vendorId: number,
  from?: string,
  to?: string,
): Promise<{ portal: Row[]; tally: Row[]; portalBalance: string; tallyBalance: string }> {
  const [portal, tally] = await Promise.all([
    entries(vendorId, 'PORTAL', from, to),
    entries(vendorId, 'TALLY', from, to),
  ]);

  const sum = (rows: Row[]) => rows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2);

  return {
    portal,
    tally,
    portalBalance: sum(portal),
    tallyBalance: sum(tally),
  };
}
