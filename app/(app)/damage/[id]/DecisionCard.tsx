'use client';

/**
 * What happens to inspected damage.
 *
 * Three outcomes, and the form shows why two of them may be closed off rather
 * than simply hiding them — a warranty claim needs the stock to have been in
 * warranty on the day the damage was SEEN, not today, and a write-off above
 * ₹50,000 needs an insurance claim reference (conflict C-13, which the
 * prototype never asked for).
 *
 * A write-off is banded, so it opens an approval chain and destroys nothing
 * until every level clears. The other two land on a single approval. Whichever
 * route it takes, the person who reported the damage is not the one who
 * approves what happens to it.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Banner, Card, FieldError, StatusChip, fmtDate, fmtMoney } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

/** Above this, a write-off needs an insurance reference. */
const INSURANCE_THRESHOLD = 50_000;

interface Approval {
  id: number;
  level_no: number;
  required_role: string;
  state: string;
  approver_name: string | null;
  remarks: string | null;
}

interface Report {
  id: number;
  status: string;
  decision: string | null;
  estimated_value: string;
  in_warranty: boolean;
  warranty_until: string | null;
  observed_on: string;
  insurance_claim_ref: string | null;
  reported_by: number;
  vendor_name: string | null;
}

const CHOICES = [
  {
    value: 'INTERNAL_REPAIR',
    label: 'Repair it here',
    hint: 'Moves to under repair, and back to available stock once it is fixed.',
  },
  {
    value: 'WARRANTY_CLAIM',
    label: 'Claim under warranty',
    hint: 'Clears the way for a return to the vendor. The stock stays quarantined until it leaves.',
  },
  {
    value: 'WRITE_OFF',
    label: 'Write it off',
    hint: 'Destroys the stock. Banded by value, so it needs approving before anything happens.',
  },
];

export function DecisionCard({
  report,
  granted,
  userId,
  roles,
  onChanged,
}: {
  report: Report;
  granted: string[];
  userId: number;
  roles: string[];
  onChanged: () => void;
}) {
  const [decision, setDecision] = useState('');
  const [insuranceRef, setInsuranceRef] = useState('');
  const [remarks, setRemarks] = useState('');

  const approvals = useResource<Approval[]>(
    report.decision === 'WRITE_OFF' ? `/api/damage/${report.id}/approvals` : null,
    [report.decision, report.status],
  );

  const act = useMutation(
    async (body: Record<string, unknown>) => api.post(`/api/damage/${report.id}/transition`, body),
    { onDone: () => { setDecision(''); setInsuranceRef(''); setRemarks(''); onChanged(); } },
  );

  const value = Number(report.estimated_value);
  const needsInsurance = value > INSURANCE_THRESHOLD;
  const isReporter = Number(report.reported_by) === userId;

  const canDecide = report.status === 'DMG_INSPECTED' && granted.includes('DAMAGE.DECIDE');
  const pending = report.status === 'DMG_DECISION_PENDING_APPROVAL';
  const err = (field: string) => (act.fieldError?.field === field ? act.fieldError.message : null);

  // On a write-off the chain decides who is next; otherwise it is anyone with
  // the permission who did not report it.
  const current = (approvals.data ?? []).find(a => a.state === 'PENDING') ?? null;
  const canApprove =
    pending &&
    granted.includes('DAMAGE.APPROVE_DECISION') &&
    !isReporter &&
    (report.decision !== 'WRITE_OFF' || (current !== null && roles.includes(current.required_role)));

  if (canDecide) {
    return (
      <Card title="What happens to it?" label="Decision">
        <form
          className="pad"
          onSubmit={e => {
            e.preventDefault();
            void act.run({
              action: 'decide',
              decision,
              insurance_claim_ref: insuranceRef || null,
            });
          }}
        >
          {act.error && <Banner kind="bad">{act.error}</Banner>}

          {CHOICES.map(c => {
            const blocked = c.value === 'WARRANTY_CLAIM' && !report.in_warranty;
            return (
              <label
                key={c.value}
                htmlFor={`dc-${c.value}`}
                style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 0',
                  opacity: blocked ? 0.5 : 1, cursor: blocked ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  id={`dc-${c.value}`}
                  type="radio"
                  name="damage-decision"
                  value={c.value}
                  checked={decision === c.value}
                  disabled={blocked}
                  onChange={e => setDecision(e.target.value)}
                  style={{ marginTop: 4 }}
                />
                <span>
                  <strong>{c.label}</strong>
                  <div className="sub">{c.hint}</div>
                  {blocked && (
                    <div className="sub">
                      <strong>
                        {report.warranty_until
                          ? `Not available — the warranty ran out on ${fmtDate(report.warranty_until)}, before the damage was seen on ${fmtDate(report.observed_on)}.`
                          : 'Not available — no warranty is recorded against this stock.'}
                      </strong>
                    </div>
                  )}
                </span>
              </label>
            );
          })}

          {decision === 'WRITE_OFF' && needsInsurance && (
            <div className="field">
              <label htmlFor="dc-insurance">Insurance claim reference</label>
              <input
                id="dc-insurance"
                className="inp"
                value={insuranceRef}
                onChange={e => setInsuranceRef(e.target.value)}
                required
                maxLength={120}
                placeholder="NIC/2026/CG/00817"
              />
              <span className="sub">
                Required: at ₹{fmtMoney(value)} this is above the ₹50,000 threshold.
              </span>
              {err('insurance_claim_ref') && <FieldError id="dc-insurance">{err('insurance_claim_ref')}</FieldError>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={act.busy || !decision || (decision === 'WRITE_OFF' && needsInsurance && !insuranceRef.trim())}
            >
              {act.busy ? 'Proposing…' : 'Propose this'}
            </button>
          </div>

          <p className="sub" style={{ marginBottom: 0 }}>
            Proposing is not deciding — somebody else approves it, and on a write-off that may be more than
            one person.
          </p>
        </form>
      </Card>
    );
  }

  if (!pending) return null;

  return (
    <Card
      title="Proposed decision"
      subtitle={report.decision?.replace(/_/g, ' ').toLowerCase()}
      label="Decision"
    >
      <div className="pad">
        {act.error && <Banner kind="bad">{act.error}</Banner>}

        {report.insurance_claim_ref && (
          <Banner kind="info">
            Insurance claim <span className="mono">{report.insurance_claim_ref}</span> — required because
            the value is above ₹50,000.
          </Banner>
        )}

        {report.decision === 'WRITE_OFF' && (approvals.data?.length ?? 0) > 0 && (
          <div className="tbl" style={{ marginBottom: 12 }}>
            <div className="tr th" style={{ gridTemplateColumns: '70px 160px 1fr 130px' }}>
              <div>Level</div>
              <div>Required role</div>
              <div>Decided by</div>
              <div>State</div>
            </div>
            {(approvals.data ?? []).map(a => (
              <div key={a.id} className="tr" style={{ gridTemplateColumns: '70px 160px 1fr 130px' }}>
                <div className="sub">{a.level_no}</div>
                <div className="mono">{a.required_role}</div>
                <div>
                  {a.approver_name ?? <span className="sub">Not yet</span>}
                  {a.remarks && <div className="sub">{a.remarks}</div>}
                </div>
                <div><StatusChip status={a.state} /></div>
              </div>
            ))}
          </div>
        )}

        {isReporter && (
          <Banner kind="warn">
            You reported this, so somebody else approves what happens to it.
          </Banner>
        )}

        {!isReporter && !canApprove && current && (
          <Banner kind="info">
            Level {current.level_no} is next, and needs {current.required_role}.
          </Banner>
        )}

        {canApprove && (
          <>
            {report.decision === 'WRITE_OFF' && (
              <Banner kind="warn">
                Approving the last level destroys this stock. It moves to written off and does not come
                back.
              </Banner>
            )}
            <div className="field">
              <label htmlFor="dc-remarks">Remarks</label>
              <input
                id="dc-remarks"
                className="inp"
                value={remarks}
                onChange={e => setRemarks(e.target.value)}
                maxLength={500}
                placeholder="Optional"
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run({ action: 'approve', remarks })}>
                {act.busy ? 'Approving…' : 'Approve'}
              </button>
              {report.decision === 'WRITE_OFF' && (
                <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run({ action: 'reject', remarks })}>
                  Refuse the write-off
                </button>
              )}
            </div>
            {report.decision === 'WRITE_OFF' && (
              <p className="sub" style={{ marginBottom: 0 }}>
                Refusing sends it back to the inspectors with the stock still quarantined. Nothing is
                destroyed on a refusal.
              </p>
            )}
          </>
        )}

        {report.decision === 'WARRANTY_CLAIM' && report.status === 'DMG_RETURN_RAISED' && (
          <Banner kind="ok">
            Cleared to return to {report.vendor_name ?? 'the vendor'}.{' '}
            <Link href="/returns">Raise the purchase return</Link> — the stock stays quarantined until it
            physically leaves.
          </Banner>
        )}
      </div>
    </Card>
  );
}
