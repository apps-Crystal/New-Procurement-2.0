/**
 * Document numbering (brief §30).
 *
 * Business document numbers are minted ONLY by `next_document_no()`, which
 * increments `id_counters` atomically inside the caller's transaction. Never
 * generated in JavaScript, never derived from a count, never formatted on the
 * client.
 *
 * Format: ENTITY-SiteCode-MonYYYY/0001 — e.g. MR-Dhulagarh-Sep2026/0047.
 *
 * The schema's comment says this function exists to fix "the v1.0
 * read-increment-write race". It does, because `INSERT … ON CONFLICT DO UPDATE
 * … RETURNING` is a single atomic statement. Two concurrent callers serialise
 * on the row lock and get different serials.
 */
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/errors';

/** Entity prefixes, exactly as listed on id_counters in the schema. */
export const DOC_ENTITIES = [
  'MR', // material request
  'PR', // purchase request
  'PO', // purchase order
  'GI', // gate inward
  'QC', // QC inspection
  'GRN', // goods receipt note
  'DMG', // damage report
  'SHT', // shortfall case
  'RTV', // purchase return
  'RGP', // returnable gate pass
  'PRN', // purchase return note, minted with the gate pass on approval
  'DN', // debit note
  'TRF', // stock transfer
  'SL', // stock ledger entry
  'ISS', // stock issue
  'ADJ', // stock adjustment (conflict C-27)
] as const;

export type DocEntity = (typeof DOC_ENTITIES)[number];

/**
 * Mint the next document number for an entity at a site.
 *
 * Must run inside the transaction that inserts the row. The counter increments
 * on call, so a rolled-back transaction leaves no gap — precisely because the
 * increment rolls back with it.
 */
export async function nextDocumentNo(tx: Tx, entity: DocEntity, siteCode: string): Promise<string> {
  if (!DOC_ENTITIES.includes(entity)) {
    throw new AppError('INTERNAL', `Unknown document entity "${entity}"`);
  }
  const code = siteCode?.trim();
  if (!code) throw new AppError('INTERNAL', 'A site code is required to mint a document number.');

  const rows = await tx<{ next_document_no: string }[]>`
    SELECT next_document_no(${entity}, ${code})`;
  return rows[0].next_document_no;
}

/** Site code for a site id, inside the transaction. */
export async function siteCodeFor(tx: Tx, siteId: number): Promise<string> {
  const rows = await tx<{ code: string }[]>`SELECT code FROM sites WHERE id = ${siteId}`;
  if (!rows.length) throw new AppError('NOT_FOUND', 'That site no longer exists.');
  return rows[0].code;
}

/** Convenience: mint a number for a site id rather than a code. */
export async function nextDocumentNoForSite(tx: Tx, entity: DocEntity, siteId: number): Promise<string> {
  return nextDocumentNo(tx, entity, await siteCodeFor(tx, siteId));
}
