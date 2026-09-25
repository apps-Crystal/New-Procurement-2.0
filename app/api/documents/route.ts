/**
 * GET  /api/documents?entity_type=&entity_id=   what is attached
 * POST /api/documents                            attach a file (multipart)
 *
 * The upload is multipart rather than JSON, so it does not go through
 * `readJson`. Everything else — the principal, the error envelope — is the
 * same as every other route.
 *
 * Size is checked twice: once here against the declared length, so a 40 MB
 * upload is refused before it is read into memory, and once in the service
 * against the bytes actually received, because a declared length is a claim.
 */
import { handler, requireEnum, requireId, requireString } from '@/lib/api';
import { badRequest } from '@/lib/errors';
import {
  DOCUMENT_ENTITIES, MAX_BYTES, listDocuments, uploadDocument,
} from '@/lib/services/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async ({ req, principal }) => {
  const p = req.nextUrl.searchParams;
  return listDocuments(
    principal,
    requireString(p.get('entity_type'), 'entity_type'),
    requireId(p.get('entity_id'), 'entity_id'),
  );
});

export const POST = handler(async ({ principal, ip, req }) => {
  // Refuse an oversized body before reading it, where the client told us.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES * 1.1) {
    throw badRequest(
      `That upload is ${(declared / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
      'file',
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest('That upload was not a valid file submission.');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw badRequest('No file was attached.', 'file');
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  return uploadDocument(
    { principal, ip },
    {
      entityType: requireEnum(form.get('entity_type'), 'entity_type', DOCUMENT_ENTITIES),
      entityId: requireId(form.get('entity_id'), 'entity_id'),
      docType: requireString(form.get('doc_type'), 'doc_type', { max: 40 }),
      fileName: file.name,
      // The browser's guess, which is why the service checks it against the
      // extension rather than trusting it.
      mimeType: file.type || 'application/octet-stream',
      bytes,
    },
  );
});
