/**
 * Stock issue (brief §18) — material leaving the warehouse for use.
 *
 * An issue is the simplest thing in the system and the easiest to get wrong:
 * it is the only routine movement that takes stock out and gives nothing back.
 * There is no approval chain, because a Warehouse Lead issuing against a work
 * order is doing their job — but `INVENTORY.ISSUE` belongs to CG_WHL alone, and
 * the movement cannot overdraw.
 *
 * `stock_issues` has no status column: an issue either happened or it did not.
 * That is why every line posts inside one transaction — a partly-issued receipt
 * would be a state the schema cannot express.
 *
 * Correcting one is a reversal on the ledger (§29), not an edit here.
 */
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { nextDocumentNoForSite } from '@/lib/doc-no';
import { can } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { issue as postIssue, availableForUpdate } from '@/lib/services/stock';
import { normaliseText } from '@/lib/validate';
import type { Actor, Row } from '@/lib/services/masters';
import type { Principal } from '@/lib/auth/permissions';

const ENTITY = 'STOCK_ISSUE';

export interface IssueLineInput {
  itemId: number;
  qty: string;
  locationId?: number | null;
}

export interface IssueInput {
  siteId: number;
  /** Department, work order or person the stock is going to. */
  issuedTo: string;
  lines: IssueLineInput[];
}

/**
 * Issue stock.
 *
 * Availability is checked under a lock before posting, so two people issuing
 * the last pallet cannot both succeed. `CHECK (qty >= 0)` on `stock_balances`
 * is still the backstop — this exists to turn a constraint violation into a
 * sentence naming the item and what is actually there.
 */
export async function createIssue(actor: Actor, input: IssueInput): Promise<{ issue: Row; lines: Row[] }> {
  const issuedTo = normaliseText(input.issuedTo);
  if (!issuedTo || issuedTo.length < 2) {
    throw badRequest('Say who or what this is being issued to — a department, a work order, a person.', 'issued_to');
  }
  if (input.lines.length === 0) {
    throw badRequest('An issue needs at least one line.', 'lines');
  }

  // The same item twice would post two movements against one issue line's worth
  // of intent, and the second would read as a separate issue in the ledger.
  const itemIds = input.lines.map(l => l.itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    throw badRequest('The same item appears on more than one line. Combine them.', 'lines');
  }

  return inTransaction(async tx => {
    if (!can(actor.principal, 'INVENTORY.ISSUE', input.siteId)) {
      throw forbidden('Issuing stock is the Warehouse Lead’s to do, at their own site.');
    }

    const [site] = await tx<Row[]>`SELECT id, code FROM sites WHERE id = ${input.siteId}`;
    if (!site) throw notFound('That site no longer exists.');

    // Check everything before posting anything, so a shortfall on the third
    // line does not leave the first two issued.
    for (const line of input.lines) {
      const [item] = await tx<Row[]>`SELECT code, name, uom FROM items WHERE id = ${line.itemId}`;
      if (!item) throw notFound('One of those items no longer exists.');

      const wanted = Number(line.qty);
      if (!Number.isFinite(wanted) || wanted <= 0) {
        throw badRequest(`${item.code}: an issued quantity must be more than zero.`, 'qty');
      }

      const available = await availableForUpdate(tx, input.siteId, line.itemId);
      if (available < wanted) {
        throw conflict(
          `${site.code} has ${available} ${item.uom} of ${item.name} available, which is not enough to issue ${wanted}.`,
        );
      }
    }

    const issueNo = await nextDocumentNoForSite(tx, 'ISS', input.siteId);

    const [created] = await tx<Row[]>`
      INSERT INTO stock_issues (issue_no, site_id, issued_to, issued_by)
      VALUES (${issueNo}, ${input.siteId}, ${issuedTo}, ${actor.principal.userId})
      RETURNING *`;

    const lines: Row[] = [];

    for (const line of input.lines) {
      const [saved] = await tx<Row[]>`
        INSERT INTO stock_issue_lines (issue_id, item_id, qty)
        VALUES (${created.id as number}, ${line.itemId}, ${line.qty}::numeric)
        RETURNING *`;

      await postIssue(tx, {
        siteId: input.siteId,
        itemId: line.itemId,
        qty: line.qty,
        issueLineId: Number(saved.id),
        userId: actor.principal.userId,
        locationId: line.locationId ?? null,
      });

      lines.push(saved);
    }

    await audit(tx, {
      entityType: ENTITY, entityId: Number(created.id), action: 'CREATE',
      after: { issue_no: issueNo, issued_to: issuedTo, lines: lines.length },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `Issued to ${issuedTo}`,
    });

    return { issue: created, lines };
  });
}

// =============================================================================
// Reads
// =============================================================================

export function listIssues(
  principal: Principal,
  filters: { siteId?: number; from?: string; to?: string } = {},
): Promise<Row[]> {
  const siteIds = principal.groupWide ? null : principal.sites.map(s => s.siteId);

  return sql<Row[]>`
    SELECT si.*, s.code AS site_code, s.name AS site_name, u.full_name AS issued_by_name,
           (SELECT count(*) FROM stock_issue_lines l WHERE l.issue_id = si.id)                 AS line_count,
           (SELECT coalesce(sum(l.qty), 0) FROM stock_issue_lines l WHERE l.issue_id = si.id)  AS total_qty
      FROM stock_issues si
      JOIN sites s     ON s.id = si.site_id
      JOIN app_users u ON u.id = si.issued_by
     WHERE (${siteIds}::bigint[] IS NULL OR si.site_id = ANY(${siteIds}))
       AND (${filters.siteId ?? null}::bigint IS NULL OR si.site_id = ${filters.siteId ?? null})
       AND (${filters.from ?? null}::date IS NULL OR si.issued_at >= ${filters.from ?? null}::date)
       AND (${filters.to ?? null}::date IS NULL OR si.issued_at < ${filters.to ?? null}::date + 1)
     ORDER BY si.issued_at DESC
     LIMIT 200`;
}

export async function getIssue(id: number): Promise<{ issue: Row; lines: Row[] }> {
  const [issue] = await sql<Row[]>`
    SELECT si.*, s.code AS site_code, s.name AS site_name, u.full_name AS issued_by_name
      FROM stock_issues si
      JOIN sites s     ON s.id = si.site_id
      JOIN app_users u ON u.id = si.issued_by
     WHERE si.id = ${id}`;

  if (!issue) throw notFound('That stock issue no longer exists.');

  const lines = await sql<Row[]>`
    SELECT l.*, i.code AS item_code, i.name AS item_name, i.uom,
           e.id AS stock_entry_id, e.entry_no, e.location_id, loc.code AS location_code,
           rev.id IS NOT NULL AS is_reversed
      FROM stock_issue_lines l
      JOIN items i ON i.id = l.item_id
      -- The ledger points at the line through the source index, the same way
      -- every other movement names what caused it.
      LEFT JOIN stock_ledger e        ON e.source_type = 'ISSUE_LINE' AND e.source_id = l.id
      LEFT JOIN storage_locations loc ON loc.id = e.location_id
      LEFT JOIN stock_ledger rev      ON rev.reverses_entry_id = e.id
     WHERE l.issue_id = ${id}
     ORDER BY l.id`;

  return { issue, lines };
}
