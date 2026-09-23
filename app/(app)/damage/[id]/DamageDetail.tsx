'use client';

/**
 * A damage report, and the joint inspection it needs.
 *
 * Two signatures, from two different roles, from two different people — and
 * never from whoever reported it. The screen shows who has signed and who is
 * still needed, because "awaiting inspection" on its own does not tell anyone
 * whether they are the one being waited for.
 *
 * Once both have signed, the decision card takes over: repair, warranty claim
 * or write-off. Two of the three are constrained rather than free — a warranty
 * claim needs the stock to have been in warranty on the day the damage was
 * SEEN, and a write-off above ₹50,000 needs an insurance reference.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  Banner, Card, EmptyState, ErrorState, LoadingState, StatusChip, Tile,
  fmtDate, fmtDateTime, fmtMoney, fmtQty,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { DecisionCard } from '@/app/(app)/damage/[id]/DecisionCard';

interface Row { [k: string]: unknown }

/** Above this, a write-off needs an insurance reference (`dmg_insurance_ref`). */
const INSURANCE_THRESHOLD = 50_000;

const REQUIRED_ROLES: { role: string; label: string }[] = [
  { role: 'CG_SMGR', label: 'Site Manager' },
  { role: 'CG_QC', label: 'QC inspector' },
];

interface DamageView {
  report: Row & {
    id: number; dmg_no: string; status: string; site_name: string;
    item_code: string; item_name: string; uom: string; is_serialised: boolean;
    asset_tag: string | null; serial_no: string | null; location_code: string | null;
    qty: string; cause: string; observed_on: string; estimated_value: string;
    warranty_until: string | null; in_warranty: boolean;
    grn_no: string | null; grn_id: number | null; vendor_name: string | null;
    quarantine_entry_no: string | null;
    reported_by: number; reported_by_name: string; created_at: string;
  };
  signatures: (Row & {
    inspector_id: number; inspector_name: string; inspector_role: string;
    notes: string; inspected_at: string;
  })[];
}

export function DamageDetail({
  id,
  granted,
  userId,
  roles,
}: {
  id: number;
  granted: string[];
  userId: number;
  roles: string[];
}) {
  const { data, loading, error, reload } = useResource<DamageView>(`/api/damage/${id}`);
  const [notes, setNotes] = useState('');
  const [repairNotes, setRepairNotes] = useState('');

  const sign = useMutation(
    async () => api.post(`/api/damage/${id}/inspect`, { notes }),
    { onDone: () => { setNotes(''); reload(); } },
  );

  const repair = useMutation(
    async () => api.post(`/api/damage/${id}/transition`, { action: 'repair-complete', notes: repairNotes }),
    { onDone: () => { setRepairNotes(''); reload(); } },
  );

  if (loading) return <LoadingState rows={7} label="Loading the report" />;
  if (error) {
    return <ErrorState message={error} retry={<button type="button" className="btn" onClick={reload}>Try again</button>} />;
  }
  if (!data) return <EmptyState title="Nothing to show" />;

  const { report, signatures } = data;

  const isReporter = Number(report.reported_by) === userId;
  const alreadySigned = signatures.some(s => Number(s.inspector_id) === userId);
  const signedRoles = new Set(signatures.map(s => String(s.inspector_role)));
  const stillNeeded = REQUIRED_ROLES.filter(r => !signedRoles.has(r.role));

  const open = report.status === 'DMG_REPORTED';
  const myRole = REQUIRED_ROLES.find(r => roles.includes(r.role) && !signedRoles.has(r.role));
  const canSign = open && granted.includes('DAMAGE.INSPECT') && !isReporter && !alreadySigned && myRole !== undefined;

  const needsInsurance = Number(report.estimated_value) > INSURANCE_THRESHOLD;

  return (
    <>
      <Card label="Summary">
        <div className="card-h">
          <div>
            <h2>
              <span className="mono">{report.dmg_no}</span> <StatusChip status={report.status} />
            </h2>
            <span className="sub">
              {report.item_name} at {report.site_name} · reported by {report.reported_by_name} on{' '}
              {fmtDate(report.created_at)}
            </span>
          </div>
        </div>

        <div className="pad grid g4">
          <Tile
            label="Quantity"
            value={`${fmtQty(report.qty)} ${report.uom}`}
            hint={report.asset_tag ?? report.location_code ?? undefined}
          />
          <Tile label="Cause" value={report.cause.replace(/_/g, ' ').toLowerCase()} hint={`Observed ${fmtDate(report.observed_on)}`} />
          <Tile
            label="Estimated value"
            value={`₹${fmtMoney(report.estimated_value)}`}
            hint={report.grn_no ? `At the ${report.grn_no} rate` : 'Estimated at report'}
          />
          <Tile
            label="Warranty"
            value={report.in_warranty ? 'In warranty' : 'Not in warranty'}
            hint={report.warranty_until ? `Until ${fmtDate(report.warranty_until)}` : 'No warranty recorded'}
          />
        </div>

        {report.quarantine_entry_no && (
          <div className="pad sub" style={{ paddingTop: 0 }}>
            Quarantined by ledger entry <span className="mono">{report.quarantine_entry_no}</span> — this
            stock left the available pool the moment it was reported.
            {report.grn_id && (
              <>
                {' '}Received on <Link href={`/grn/${report.grn_id}`} className="mono">{report.grn_no}</Link>
                {report.vendor_name && ` from ${report.vendor_name}`}.
              </>
            )}
          </div>
        )}
      </Card>

      {needsInsurance && (
        <Banner kind="warn">
          At ₹{fmtMoney(report.estimated_value)} this is above the ₹50,000 threshold, so a write-off will
          need an insurance claim reference before it can be recorded.
        </Banner>
      )}

      {report.in_warranty && (
        <Banner kind="info">
          This was in warranty when the damage was seen, so a warranty claim against{' '}
          {report.vendor_name ?? 'the vendor'} is open as an option. That stops being true once the
          warranty lapses — the date the damage was observed is what counts, not today.
        </Banner>
      )}

      {report.status !== 'DMG_REPORTED' && (
        <DecisionCard
          report={{
            id: report.id,
            status: report.status,
            decision: (report.decision as string | null) ?? null,
            estimated_value: report.estimated_value,
            in_warranty: report.in_warranty,
            warranty_until: report.warranty_until,
            observed_on: report.observed_on,
            insurance_claim_ref: (report.insurance_claim_ref as string | null) ?? null,
            reported_by: Number(report.reported_by),
            vendor_name: report.vendor_name,
          }}
          granted={granted}
          userId={userId}
          roles={roles}
          onChanged={reload}
        />
      )}

      {report.status === 'DMG_UNDER_REPAIR' && (
        <Card title="Under repair" label="Repair">
          <div className="pad">
            {repair.error && <Banner kind="bad">{repair.error}</Banner>}
            <p className="sub" style={{ marginTop: 0 }}>
              The stock is out of damaged hold and in the repair bucket. Completing puts it back on the
              shelf — which is the only route by which quarantined stock becomes issuable again.
            </p>
            {granted.includes('DAMAGE.CLOSE') ? (
              <form
                onSubmit={e => {
                  e.preventDefault();
                  void repair.run(undefined);
                }}
              >
                <div className="field">
                  <label htmlFor="dm-repair">What was done?</label>
                  <input
                    id="dm-repair"
                    className="inp"
                    value={repairNotes}
                    onChange={e => setRepairNotes(e.target.value)}
                    maxLength={1000}
                    placeholder="Optional"
                  />
                </div>
                <button type="submit" className="btn btn-primary" disabled={repair.busy}>
                  {repair.busy ? 'Closing…' : 'Repaired and back in stock'}
                </button>
              </form>
            ) : (
              <Banner kind="info">A Warehouse Lead or Site Manager closes this once it is fixed.</Banner>
            )}
          </div>
        </Card>
      )}

      <Card
        title="Joint inspection"
        subtitle="A Site Manager and a QC inspector both sign, and neither may be the person who reported it."
        label="Inspection"
      >
        <div className="tbl">
          <div className="tr th" style={{ gridTemplateColumns: '170px 170px 1fr 160px' }}>
            <div>Role</div>
            <div>Signed by</div>
            <div>What they saw</div>
            <div>When</div>
          </div>
          {REQUIRED_ROLES.map(r => {
            const signature = signatures.find(s => String(s.inspector_role) === r.role);
            return (
              <div key={r.role} className="tr" style={{ gridTemplateColumns: '170px 170px 1fr 160px' }}>
                <div>{r.label}</div>
                <div>
                  {signature ? (
                    String(signature.inspector_name)
                  ) : (
                    <span className="sub">Not yet</span>
                  )}
                </div>
                <div className="sub">{signature ? String(signature.notes) : '—'}</div>
                <div className="sub">{signature ? fmtDateTime(signature.inspected_at) : '—'}</div>
              </div>
            );
          })}
        </div>

        <div className="pad">
          {sign.error && <Banner kind="bad">{sign.error}</Banner>}

          {!open && (
            <Banner kind="ok">
              Both inspectors have signed. What happens to this stock — repair, a warranty claim or a
              write-off — is decided next.
            </Banner>
          )}

          {open && isReporter && (
            <Banner kind="warn">
              You reported this, so the inspection is somebody else&rsquo;s to sign. It needs{' '}
              {stillNeeded.map(r => r.label).join(' and ')}.
            </Banner>
          )}

          {open && alreadySigned && (
            <Banner kind="info">
              You have signed. Still waiting on {stillNeeded.map(r => r.label).join(' and ')}.
            </Banner>
          )}

          {open && !isReporter && !alreadySigned && !canSign && (
            <Banner kind="info">
              This is waiting for {stillNeeded.map(r => r.label).join(' and ')}.
            </Banner>
          )}

          {canSign && (
            <form
              onSubmit={e => {
                e.preventDefault();
                void sign.run(undefined);
              }}
            >
              <div className="field">
                <label htmlFor="dm-notes">What did you see? (signing as {myRole?.label})</label>
                <textarea
                  id="dm-notes"
                  className="inp"
                  rows={3}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  required
                  minLength={10}
                  maxLength={2000}
                  placeholder="The condition of the stock and what you judge caused it."
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={sign.busy || notes.trim().length < 10}>
                {sign.busy ? 'Signing…' : `Sign as ${myRole?.label}`}
              </button>
              {stillNeeded.length > 1 && (
                <p className="sub" style={{ marginBottom: 0 }}>
                  One signature is not an inspection — {stillNeeded.filter(r => r.role !== myRole?.role).map(r => r.label).join(' and ')}{' '}
                  still has to sign after you.
                </p>
              )}
            </form>
          )}
        </div>
      </Card>
    </>
  );
}
