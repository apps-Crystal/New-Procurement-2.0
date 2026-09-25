/**
 * Document upload and retrieval (brief §30).
 *
 * The schema decides most of this and it is worth reading before the code:
 *
 *   size_bytes  CHECK (> 0 AND <= 10485760)   ten megabytes, no more
 *   sha256      char(64) NOT NULL             every file is hashed
 *   virus_scanned boolean NOT NULL DEFAULT false
 *
 * Files are stored on disk under a directory the deployment chooses, named by
 * their own hash. Two people uploading the same challan write one file and two
 * rows — the rows are what carry who uploaded it, against what, and when.
 *
 * On virus scanning: there is no scanner on a localhost box, and pretending
 * otherwise by defaulting `virus_scanned` to true would be worse than leaving
 * it false. It stays false, `SCAN_MODE` records why, and `blockUnscanned()`
 * refuses to serve an unscanned file when the deployment says it should. On a
 * machine with no scanner configured that check is off and the flag is simply
 * honest about what is known.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inTransaction, sql, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { can, type Principal } from '@/lib/auth/permissions';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import type { Actor, Row } from '@/lib/services/masters';

const ENTITY = 'DOCUMENT';

/** The schema's own ceiling. Stated here so the message can name it. */
export const MAX_BYTES = 10 * 1024 * 1024;

/**
 * What may be uploaded.
 *
 * An allow-list rather than a deny-list: the question is what a warehouse
 * actually attaches — a photograph, a scan, a logger export, a spreadsheet —
 * and anything outside that is far more likely to be a mistake or an attack
 * than a legitimate document nobody thought of.
 */
export const ALLOWED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

/** Entity types a document may hang off, from the schema's own comment. */
export const DOCUMENT_ENTITIES = [
  'PR', 'QUOTATION', 'PO', 'GATE_INWARD', 'QC_LINE', 'GRN',
  'DAMAGE', 'RTV', 'DEBIT_NOTE', 'VENDOR', 'INVOICE',
] as const;

export type DocumentEntity = (typeof DOCUMENT_ENTITIES)[number];

/** Where files live. Configurable, because a container mounts a volume. */
function storageRoot(): string {
  return process.env.DOCUMENT_STORE ?? path.join(process.cwd(), '.documents');
}

/**
 * Whether an unscanned file may be served.
 *
 * `SCAN_MODE=require` refuses one. Anything else — including unset, which is
 * localhost — serves it, because a scanner that does not exist cannot be
 * waited for and blocking every download would simply mean nobody uses the
 * feature.
 */
function blockUnscanned(): boolean {
  return process.env.SCAN_MODE === 'require';
}

/** Which permission covers documents on this entity. */
function viewPermission(entityType: string): Parameters<typeof can>[1] {
  const map: Record<string, Parameters<typeof can>[1]> = {
    PR: 'PR.VIEW', QUOTATION: 'QUOTATION.VIEW', PO: 'PO.VIEW',
    GATE_INWARD: 'GATE_INWARD.VIEW', QC_LINE: 'QC.VIEW', GRN: 'GRN.VIEW',
    DAMAGE: 'DAMAGE.VIEW', RTV: 'RTV.VIEW', DEBIT_NOTE: 'DEBIT_NOTE.VIEW',
    VENDOR: 'VENDOR.VIEW', INVOICE: 'INVOICE.VIEW',
  };
  return map[entityType] ?? 'AUDIT.VIEW';
}

/**
 * Attaching a document is part of working on the record, so it takes the same
 * permission as acting on it rather than a separate one. A viewer may read
 * attachments; only somebody who can change the record may add one.
 */
function attachPermission(entityType: string): Parameters<typeof can>[1] {
  const map: Record<string, Parameters<typeof can>[1]> = {
    PR: 'PR.EDIT', QUOTATION: 'QUOTATION.MANAGE', PO: 'PO.CREATE',
    GATE_INWARD: 'GATE_INWARD.CREATE', QC_LINE: 'QC.EDIT', GRN: 'GRN.CREATE',
    DAMAGE: 'DAMAGE.CREATE', RTV: 'RTV.CREATE', DEBIT_NOTE: 'DEBIT_NOTE.ISSUE',
    VENDOR: 'VENDOR.EDIT', INVOICE: 'INVOICE.CREATE',
  };
  return map[entityType] ?? 'MASTER.ITEM_MANAGE';
}

// =============================================================================
// Upload
// =============================================================================

export interface UploadInput {
  entityType: DocumentEntity;
  entityId: number;
  docType: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  retentionClass?: string;
}

/**
 * Store a file and record it.
 *
 * The hash is computed before anything is written, so a duplicate is
 * recognised without a second copy landing on disk. The row is always written:
 * two people attaching the same photograph to two different damage reports is
 * two facts, even though it is one file.
 */
export async function uploadDocument(actor: Actor, input: UploadInput): Promise<Row> {
  const fileName = input.fileName.trim();
  if (!fileName) throw badRequest('The file needs a name.', 'file_name');

  if (input.bytes.length === 0) {
    throw badRequest('That file is empty.', 'file');
  }
  if (input.bytes.length > MAX_BYTES) {
    throw badRequest(
      `That file is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
      'file',
    );
  }

  const extensions = ALLOWED_TYPES[input.mimeType];
  if (!extensions) {
    throw badRequest(
      `${input.mimeType} files cannot be attached. Use a PDF, an image, a CSV or a spreadsheet.`,
      'file',
    );
  }

  // The extension has to agree with the declared type. A .pdf announced as an
  // image is either a mistake or an attempt, and neither should be stored.
  const ext = path.extname(fileName).toLowerCase();
  if (!extensions.includes(ext)) {
    throw badRequest(
      `The name says ${ext || 'no extension'} but the file is ${input.mimeType}. Rename it or upload the right file.`,
      'file_name',
    );
  }

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');

  // Two levels of prefix, so a directory never holds a hundred thousand files.
  const relative = path.join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  const absolute = path.join(storageRoot(), relative);

  await mkdir(path.dirname(absolute), { recursive: true });

  // Written only if it is not already there. The name is the content's hash,
  // so an existing file with that name IS this file.
  const existing = await stat(absolute).catch(() => null);
  if (!existing) {
    await writeFile(absolute, input.bytes);
  }

  return inTransaction(async tx => {
    await assertEntityExists(tx, input.entityType, input.entityId);

    if (!can(actor.principal, attachPermission(input.entityType), null)) {
      throw forbidden(`You do not have permission to attach documents to a ${friendly(input.entityType)}.`);
    }

    const [doc] = await tx<Row[]>`
      INSERT INTO documents (entity_type, entity_id, doc_type, file_name, storage_path,
                             mime_type, size_bytes, sha256, retention_class, virus_scanned,
                             uploaded_by)
      VALUES (${input.entityType}, ${input.entityId}, ${input.docType.trim().toUpperCase()},
              ${fileName}, ${relative.replace(/\\/g, '/')}, ${input.mimeType},
              ${input.bytes.length}, ${sha256},
              ${input.retentionClass ?? 'STATUTORY_8Y'}, false,
              ${actor.principal.userId})
      RETURNING *`;

    await audit(tx, {
      entityType: ENTITY, entityId: Number(doc.id), action: 'CREATE',
      after: {
        attached_to: `${input.entityType}#${input.entityId}`,
        doc_type: doc.doc_type, file_name: fileName,
        size_bytes: input.bytes.length, sha256,
        deduplicated: existing !== null,
      },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: `${doc.doc_type} attached to ${friendly(input.entityType)} ${input.entityId}`,
    });

    return doc;
  });
}

/**
 * The record has to exist before a document hangs off it.
 *
 * `documents.entity_id` is a bare bigint with no foreign key — it cannot have
 * one, because it points at eleven different tables. So the check lives here,
 * and without it an upload against a typo'd id would be stored forever and
 * found by nobody.
 */
async function assertEntityExists(tx: Tx, entityType: string, entityId: number): Promise<void> {
  const tables: Record<string, string> = {
    PR: 'purchase_requests', QUOTATION: 'quotations', PO: 'purchase_orders',
    GATE_INWARD: 'gate_inwards', QC_LINE: 'qc_lines', GRN: 'grns',
    DAMAGE: 'damage_reports', RTV: 'purchase_returns', DEBIT_NOTE: 'debit_notes',
    VENDOR: 'vendors', INVOICE: 'vendor_invoices',
  };

  const table = tables[entityType];
  if (!table) throw badRequest(`Documents cannot be attached to a ${entityType}.`, 'entity_type');

  const [row] = await tx.unsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM ${table} WHERE id = $1) AS exists`,
    [entityId],
  );

  if (!row.exists) {
    throw notFound(`That ${friendly(entityType)} no longer exists, so nothing can be attached to it.`);
  }
}

// =============================================================================
// Read
// =============================================================================

export function listDocuments(
  principal: Principal,
  entityType: string,
  entityId: number,
): Promise<Row[]> {
  if (!can(principal, viewPermission(entityType), null)) {
    throw forbidden(`You do not have permission to see documents on a ${friendly(entityType)}.`);
  }

  return sql<Row[]>`
    SELECT d.id, d.entity_type, d.entity_id, d.doc_type, d.file_name,
           d.mime_type, d.size_bytes, d.sha256, d.retention_class,
           d.virus_scanned, d.uploaded_at, u.full_name AS uploaded_by_name
      FROM documents d
      JOIN app_users u ON u.id = d.uploaded_by
     WHERE d.entity_type = ${entityType} AND d.entity_id = ${entityId}
     ORDER BY d.uploaded_at DESC`;
}

export interface FetchedDocument {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Read a file back.
 *
 * The hash is re-checked on the way out. A file that no longer matches the
 * hash recorded when it was stored has been changed on disk by something
 * outside this application, and serving it as if it were the original is the
 * one thing this function must not do.
 */
export async function fetchDocument(principal: Principal, id: number): Promise<FetchedDocument> {
  const [doc] = await sql<Row[]>`SELECT * FROM documents WHERE id = ${id}`;
  if (!doc) throw notFound('That document no longer exists.');

  if (!can(principal, viewPermission(String(doc.entity_type)), null)) {
    throw forbidden('You do not have permission to read that document.');
  }

  if (blockUnscanned() && doc.virus_scanned !== true) {
    throw conflict('That file has not been virus scanned yet. It cannot be downloaded until it has.');
  }

  const absolute = path.join(storageRoot(), String(doc.storage_path));

  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    throw notFound(
      `${doc.file_name} is recorded but its file is missing from storage. Someone will need to attach it again.`,
    );
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== String(doc.sha256)) {
    throw conflict(
      `${doc.file_name} does not match the checksum recorded when it was uploaded. It will not be served.`,
    );
  }

  return {
    fileName: String(doc.file_name),
    mimeType: String(doc.mime_type),
    bytes,
  };
}

/** Whether a given kind of document is attached. Used by the C-11 gate. */
export async function hasDocument(
  tx: Tx,
  entityType: string,
  entityId: number,
  docType: string,
): Promise<boolean> {
  const [row] = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM documents
       WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND doc_type = ${docType}
    ) AS exists`;
  return row.exists;
}

/** Mark a file scanned. For the scanner to call, once there is one. */
export async function markScanned(actor: Actor, id: number, clean: boolean): Promise<Row> {
  return inTransaction(async tx => {
    if (!can(actor.principal, 'MASTER.ITEM_MANAGE', null)) {
      throw forbidden('Only an administrator records a virus scan result.');
    }

    const [doc] = await tx<Row[]>`
      UPDATE documents SET virus_scanned = ${clean} WHERE id = ${id} RETURNING *`;
    if (!doc) throw notFound('That document no longer exists.');

    await audit(tx, {
      entityType: ENTITY, entityId: id, action: clean ? 'UPDATE' : 'OVERRIDE',
      after: { virus_scanned: clean },
      userId: actor.principal.userId, ip: actor.ip,
      remarks: clean ? 'Scanned clean' : 'Scan failed — the file is flagged',
    });

    return doc;
  });
}

function friendly(entityType: string): string {
  return entityType.toLowerCase().replace(/_/g, ' ');
}
