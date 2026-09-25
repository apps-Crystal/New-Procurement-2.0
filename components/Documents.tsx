'use client';

/**
 * The attachments panel, shared by every record that can carry one.
 *
 * Deliberately one component rather than one per screen: an attachment behaves
 * the same on a damage report as on a gate inward, and eleven copies of this
 * would drift apart within a month.
 *
 * `required` names document types the record is waiting for — the cold-chain
 * data logger, most importantly (conflict C-11). A required type that is not
 * yet attached is shown as outstanding rather than merely absent, because
 * "nothing here" and "something is missing" are different things to a reader.
 */
import { useState } from 'react';
import { Banner, Card, fmtDateTime } from '@/components/ui';
import { useResource } from '@/lib/client/use-resource';
import { qs } from '@/lib/client/api';

interface Doc {
  id: number;
  doc_type: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  virus_scanned: boolean;
  uploaded_at: string;
  uploaded_by_name: string;
}

export interface DocumentsProps {
  entityType: string;
  entityId: number;
  /** Types this record needs. Anything missing is called out. */
  required?: { type: string; why: string }[];
  /** Types offered in the picker, beyond whatever is required. */
  offered?: string[];
  /** False while the record is in a state that should not gain attachments. */
  canAttach?: boolean;
}

function humanSize(bytes: string): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Documents({
  entityType,
  entityId,
  required = [],
  offered = [],
  canAttach = true,
}: DocumentsProps) {
  const url = `/api/documents${qs({ entity_type: entityType, entity_id: entityId })}`;
  const { data, loading, error, reload } = useResource<Doc[]>(url);

  const [docType, setDocType] = useState(required[0]?.type ?? offered[0] ?? 'PHOTO');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const attached = data ?? [];
  const missing = required.filter(r => !attached.some(d => d.doc_type === r.type));

  const types = [...new Set([...required.map(r => r.type), ...offered, 'PHOTO', 'OTHER'])];

  async function upload(file: File) {
    setBusy(true);
    setProblem(null);

    const form = new FormData();
    form.set('entity_type', entityType);
    form.set('entity_id', String(entityId));
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
      setBusy(false);
    }
  }

  return (
    <Card
      title="Attachments"
      subtitle={attached.length === 0 ? 'Nothing attached yet' : `${attached.length} attached`}
      label="Attachments"
    >
      <div className="pad">
        {problem && <Banner kind="bad">{problem}</Banner>}
        {error && <Banner kind="bad">{error}</Banner>}

        {missing.length > 0 && (
          <Banner kind="warn">
            {missing.map(m => `${m.type.replace(/_/g, ' ').toLowerCase()} — ${m.why}`).join('; ')}
          </Banner>
        )}

        {canAttach && (
          <div className="grid g2" style={{ marginBottom: 12 }}>
            <div className="field">
              <label htmlFor={`doc-type-${entityType}-${entityId}`}>Kind of document</label>
              <select
                id={`doc-type-${entityType}-${entityId}`}
                className="inp"
                value={docType}
                onChange={e => setDocType(e.target.value)}
              >
                {types.map(t => (
                  <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor={`doc-file-${entityType}-${entityId}`}>File</label>
              <input
                id={`doc-file-${entityType}-${entityId}`}
                className="inp"
                type="file"
                disabled={busy}
                accept=".pdf,.jpg,.jpeg,.png,.webp,.csv,.txt,.xls,.xlsx"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  e.target.value = '';
                }}
              />
              <span className="sub">PDF, image, CSV or spreadsheet. Up to 10 MB.</span>
            </div>
          </div>
        )}

        {loading && <span className="sub">Loading attachments…</span>}

        {!loading && attached.length === 0 && (
          <p className="sub" style={{ margin: 0 }}>
            {canAttach
              ? 'Nothing attached yet.'
              : 'Nothing attached, and this record can no longer take any.'}
          </p>
        )}

        {attached.length > 0 && (
          <div className="tbl">
            <div className="tr th" style={{ gridTemplateColumns: '150px 1fr 100px 170px' }}>
              <div>Kind</div>
              <div>File</div>
              <div className="r">Size</div>
              <div>Attached</div>
            </div>
            {attached.map(d => (
              <div key={d.id} className="tr" style={{ gridTemplateColumns: '150px 1fr 100px 170px' }}>
                <div className="sub">{d.doc_type.replace(/_/g, ' ').toLowerCase()}</div>
                <div>
                  <a href={`/api/documents/${d.id}`} download>{d.file_name}</a>
                  {!d.virus_scanned && <div className="sub">not virus scanned</div>}
                </div>
                <div className="r sub">{humanSize(d.size_bytes)}</div>
                <div className="sub">
                  {fmtDateTime(d.uploaded_at)}
                  <div>{d.uploaded_by_name}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
