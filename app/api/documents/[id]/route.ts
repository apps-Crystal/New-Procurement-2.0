/**
 * GET /api/documents/[id] — download the file.
 *
 * This route does not use the shared `handler`, because it returns bytes
 * rather than the JSON envelope. It still resolves the principal and maps
 * errors the same way; only the success shape differs.
 *
 * `Content-Disposition: attachment` is deliberate. An HTML or SVG file served
 * inline would run in the application's own origin, which is how an uploaded
 * document becomes a stored cross-site script.
 */
import { NextRequest, NextResponse } from 'next/server';
import { fail, numericId } from '@/lib/api';
import { requirePrincipal } from '@/lib/auth/current-user';
import { fetchDocument } from '@/lib/services/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const principal = await requirePrincipal();
    const { id } = await params;
    const doc = await fetchDocument(principal, numericId(id));

    return new NextResponse(new Uint8Array(doc.bytes), {
      headers: {
        'content-type': doc.mimeType,
        'content-length': String(doc.bytes.length),
        // Quoted and escaped: a filename containing a quote would otherwise
        // end the header value early.
        'content-disposition': `attachment; filename="${doc.fileName.replace(/["\\]/g, '_')}"`,
        // Documents are per-user by permission, so no shared cache may hold one.
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (e) {
    return fail(e);
  }
}
