'use client';

/**
 * Business impact declaration.
 *
 * This is the gate between "we looked for stock" and "we will spend money", so
 * it is deliberately not a formality:
 *
 *   mr_declarations_impact_len   at least 40 characters
 *   mr_allocations               the shares must total exactly 100%
 *
 * Both are database constraints. The counter and the running total here exist
 * to save a round trip, not to decide — a declaration that slips past them is
 * still refused by the schema, with the same message.
 *
 * Per conflict C-05 the budget code belongs to the declaration rather than the
 * request, which is why it is asked for here and not on the MR form.
 */
import { useMemo, useState } from 'react';
import { Banner, Card, FieldError } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource, useSession } from '@/lib/client/use-resource';

interface BudgetCode {
  id: number;
  code: string;
  financial_year: string;
  category: string;
}

interface Allocation {
  siteId: string;
  costHead: string;
  pct: string;
}

const MIN_IMPACT = 40;

/** Statuses from which a declaration may be made. */
const DECLARABLE = new Set([
  'MR_STOCK_AVAILABLE', 'MR_STOCK_PARTIAL', 'MR_STOCK_UNAVAILABLE',
  'MR_TRANSFER_APPROVED', 'MR_TRANSFER_REJECTED',
]);

export function DeclarationForm({
  mrId,
  siteId,
  status,
  onDone,
}: {
  mrId: number;
  siteId: number;
  status: string;
  onDone: () => void;
}) {
  const session = useSession();
  const budgets = useResource<BudgetCode[]>('/api/master/budget-codes');

  const [impact, setImpact] = useState('');
  const [budgetCodeId, setBudgetCodeId] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [allocations, setAllocations] = useState<Allocation[]>([
    { siteId: String(siteId), costHead: '', pct: '100' },
  ]);

  const declare = useMutation(
    async () =>
      api.post(`/api/mr/${mrId}/declare`, {
        business_impact: impact,
        budget_code_id: Number(budgetCodeId),
        estimated_value: estimatedValue,
        allocations: allocations
          .filter(a => a.siteId && a.costHead)
          .map(a => ({ site_id: Number(a.siteId), cost_head: a.costHead, pct: a.pct })),
      }),
    { onDone, successMessage: 'Declared.' },
  );

  const total = useMemo(
    () => allocations.reduce((s, a) => s + (Number(a.pct) || 0), 0),
    [allocations],
  );

  if (!DECLARABLE.has(status)) return null;

  const sites = session.data?.sites ?? [];
  const err = (field: string) => (declare.fieldError?.field === field ? declare.fieldError.message : null);

  const short = impact.trim().length < MIN_IMPACT;
  const unbalanced = Math.abs(total - 100) > 0.001;

  const setAlloc = (i: number, patch: Partial<Allocation>) =>
    setAllocations(prev => prev.map((a, n) => (n === i ? { ...a, ...patch } : a)));

  return (
    <Card title="Declare the business impact" label="Declaration">
      <form
        className="pad"
        onSubmit={e => {
          e.preventDefault();
          void declare.run(undefined);
        }}
      >
        {declare.error && <Banner kind="bad">{declare.error}</Banner>}

        <div className="field">
          <label htmlFor="dec-impact">
            What happens if this is not bought?
          </label>
          <textarea
            id="dec-impact"
            className="inp"
            rows={4}
            value={impact}
            onChange={e => setImpact(e.target.value)}
            required
            maxLength={500}
            placeholder="Name the operational consequence, not the item. This is what an approver reads first."
            aria-describedby="dec-impact-count"
          />
          <span id="dec-impact-count" className="sub">
            {impact.trim().length} of {MIN_IMPACT} characters minimum
            {impact.length > 450 ? ` · ${500 - impact.length} left` : ''}
          </span>
          {err('business_impact') && <FieldError id="dec-impact">{err('business_impact')}</FieldError>}
        </div>

        <div className="grid g2">
          <div className="field">
            <label htmlFor="dec-budget">Budget code</label>
            <select
              id="dec-budget"
              className="inp"
              value={budgetCodeId}
              onChange={e => setBudgetCodeId(e.target.value)}
              required
            >
              <option value="">Choose…</option>
              {(budgets.data ?? []).map(b => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.financial_year}
                </option>
              ))}
            </select>
            {err('budget_code_id') && <FieldError id="dec-budget">{err('budget_code_id')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="dec-value">Estimated value (₹)</label>
            <input
              id="dec-value"
              className="inp"
              inputMode="decimal"
              value={estimatedValue}
              onChange={e => setEstimatedValue(e.target.value)}
              required
              placeholder="268000"
            />
            {err('estimated_value') && <FieldError id="dec-value">{err('estimated_value')}</FieldError>}
          </div>
        </div>

        <h4 style={{ margin: '18px 0 8px' }}>Who carries the cost</h4>

        {allocations.map((a, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 110px 40px', gap: 10, marginBottom: 8 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`dec-site-${i}`} className="sr-only">Site</label>
              <select
                id={`dec-site-${i}`}
                className="inp"
                value={a.siteId}
                onChange={e => setAlloc(i, { siteId: e.target.value })}
                required
              >
                <option value="">Choose a site…</option>
                {sites.map(s => (
                  <option key={s.siteId} value={s.siteId}>{s.siteName}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`dec-head-${i}`} className="sr-only">Cost head</label>
              <input
                id={`dec-head-${i}`}
                className="inp"
                value={a.costHead}
                onChange={e => setAlloc(i, { costHead: e.target.value })}
                placeholder="Cost head, e.g. Freezer block"
                required
                maxLength={120}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`dec-pct-${i}`} className="sr-only">Share, per cent</label>
              <input
                id={`dec-pct-${i}`}
                className="inp"
                inputMode="decimal"
                value={a.pct}
                onChange={e => setAlloc(i, { pct: e.target.value })}
                placeholder="%"
                required
              />
            </div>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`Remove allocation ${i + 1}`}
              disabled={allocations.length === 1}
              onClick={() => setAllocations(prev => prev.filter((_, n) => n !== i))}
            >
              ×
            </button>
          </div>
        ))}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setAllocations(prev => [...prev, { siteId: '', costHead: '', pct: '' }])}
          >
            Split across another site
          </button>
          <span className={unbalanced ? 'chip warn' : 'chip ok'}>
            {total}% allocated
          </span>
        </div>

        {err('allocations') && <FieldError id="dec-alloc">{err('allocations')}</FieldError>}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button type="submit" className="btn btn-primary" disabled={declare.busy || short || unbalanced}>
            {declare.busy ? 'Declaring…' : 'Declare and send for approval'}
          </button>
        </div>

        <p className="sub" style={{ marginBottom: 0 }}>
          Once declared, the request&rsquo;s lines are locked and it goes to a site manager. You cannot
          approve your own request.
        </p>
      </form>
    </Card>
  );
}
