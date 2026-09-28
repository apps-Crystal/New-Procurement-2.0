'use client';

/**
 * KYC documents — the four papers that prove a vendor is who they say they are.
 *
 * Named slots rather than the generic attachments panel, because for KYC the
 * useful question is "what is still missing", not "what has been attached". A
 * dropdown of document kinds answers the second and hides the first.
 *
 * They ride on the same `documents` table and the same /api/documents endpoint
 * as every other attachment, so the hash check, the 10 MB ceiling, the type
 * allow-list and the retention class all apply unchanged. The only thing that
 * differs is how they are presented.
 *
 * On "or paste a link", which the reference design offers: see C-31. A link has
 * no bytes to hash, no size and no retention, and the one thing KYC has to do
 * is still be there at an audit years later. It is not implemented, and the
 * panel says so rather than pretending.
 */
import { useState } from 'react';
import { Banner, Card, fmtDateTime } from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';

interface Doc {
  id: number;
  doc_type: string;
  file_name: string;
  size_bytes: string;
  virus_scanned: boolean;
  uploaded_at: string;
  uploaded_by_name: string;
}

/**
 * `KYC_PAN` is the schema's own example doc_type (see the comment on
 * `documents.doc_type`), so the rest follow its shape.
 */
export const KYC_SLOTS = [
  { type: 'KYC_GST', label: 'GST Certificate', hint: 'Not needed for an unregistered vendor' },
  { type: 'KYC_PAN', label: 'PAN Card', hint: 'Must match the PAN on the registration above' },
  { type: 'KYC_CHEQUE', label: 'Cancelled Cheque', hint: 'Proves the bank account belongs to the vendor' },
  { type: 'KYC_MSME', label: 'MSME Certificate', hint: 'Only if the vendor is registered under MSME' },
] as const;

function humanSize(bytes: string): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function VendorKyc({
  vendorId,
  canAttach,
  /** Rendered flat, without the Card chrome, when it sits inside another card. */
  bare = false,
}: {
  vendorId: number;
  canAttach: boolean;
  bare?: boolean;
}) {
  const url = `/api/documents${qs({ entity_type: 'VENDOR', entity_id: vendorId })}`;
  const { data, loading, error, reload } = useResource<Doc[]>(url);

  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const attached = data ?? [];
  const held = (type: string) => attached.find(d => d.doc_type === type);
  const have = KYC_SLOTS.filter(s => held(s.type)).length;

  async function upload(docType: string, file: File) {
    setBusy(docType);
    setProblem(null);

    const form = new FormData();
    form.set('entity_type', 'VENDOR');
    form.set('entity_id', String(vendorId));
    form.set('doc_type', docType);
    form.set('file', file);

    try {
      // Not through lib/client/api: that sets a JSON content type, and a
      // multipart body needs the browser to set its own boundary.
      const res = await fetch('/api/documents', { method: 'POST', body: form });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error?.message ?? 'That upload failed.');
      reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That upload failed.');
    } finally {
      setBusy(null);
    }
  }

  const body = (
    <>
      {problem && <Banner kind="bad">{problem}</Banner>}
      {error && <Banner kind="bad">{error}</Banner>}

      <div className="col" style={{ gap: 10 }}>
        {KYC_SLOTS.map(slot => {
          const doc = held(slot.type);
          const uploading = busy === slot.type;

          return (
            <div key={slot.type} className="kyc-slot">
              <span className={`kyc-dot ${doc ? 'is-held' : ''}`} aria-hidden="true" />

              <div style={{ minWidth: 0 }}>
                <div className="b">{slot.label}</div>
                {doc ? (
                  <div className="sub">
                    <a href={`/api/documents/${doc.id}`} download>
                      {doc.file_name}
                    </a>
                    {' · '}
                    {humanSize(doc.size_bytes)} · {fmtDateTime(doc.uploaded_at)} · {doc.uploaded_by_name}
                    {!doc.virus_scanned && <div className="sub t-warn">Not virus scanned</div>}
                  </div>
                ) : (
                  <div className="sub">{loading ? 'Checking…' : slot.hint}</div>
                )}
              </div>

              {canAttach && (
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor={`kyc-${vendorId}-${slot.type}`} className="btn btn-sm kyc-choose">
                    {uploading ? 'Uploading…' : doc ? 'Replace' : 'Choose file'}
                  </label>
                  <input
                    id={`kyc-${vendorId}-${slot.type}`}
                    type="file"
                    className="kyc-file"
                    disabled={busy !== null}
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    aria-label={`${doc ? 'Replace' : 'Upload'} the ${slot.label}`}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) void upload(slot.type, file);
                      e.target.value = '';
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
        PDF or image, up to 10 MB. Stored, hashed and checked again on download — a file altered on disk is refused
        rather than served. Replacing one keeps the old copy in the record.
      </p>
    </>
  );

  if (bare) return body;

  return (
    <Card
      title="KYC documents"
      subtitle={have === KYC_SLOTS.length ? 'All four held' : `${have} of ${KYC_SLOTS.length} held`}
      pad
      label="KYC documents"
    >
      <div style={{ marginTop: 12 }}>{body}</div>
    </Card>
  );
}
