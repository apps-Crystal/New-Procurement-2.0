'use client';

/**
 * Raise a purchase request from an approved material request.
 *
 * Quantities are not asked for. They come from `mr_lines.qty_purchase` — the
 * balance left after any transfer — and are shown read-only, because a PR that
 * could ask for more than the request behind it would defeat the point of the
 * stock check. What is asked for is the estimated rate and GST per line, which
 * the MR has no opinion about.
 *
 * Payment terms must total 100%, or carry an override note saying why they
 * cannot be expressed as percentages (`pr_payment_terms_total`).
 */
import { useMemo, useState } from 'react';
import { Banner, Card, FieldError, fmtMoney, fmtQty } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';
import { ENUMS } from '@/lib/enums';

interface ReadyMr {
  id: number;
  mr_no: string;
  site_name: string;
  category: string;
  required_by: string;
}

interface MrLine {
  id: number;
  item_code: string;
  item_name: string;
  uom: string;
  qty_purchase: string;
  default_gst_rate: string | null;
}

interface MrView {
  mr: { id: number; mr_no: string; required_by: string };
  lines: MrLine[];
}

const TERMS: { key: string; label: string }[] = [
  { key: 'pay_advance_pct', label: 'Advance' },
  { key: 'pay_before_delivery_pct', label: 'Before delivery' },
  { key: 'pay_running_pct', label: 'Running bills' },
  { key: 'pay_post_delivery_pct', label: 'After delivery' },
  { key: 'pay_post_completion_pct', label: 'After completion' },
  { key: 'pay_retention_pct', label: 'Retention' },
];

const ZERO_TERMS = Object.fromEntries(TERMS.map(t => [t.key, '0']));

export function NewPrForm({
  initialMrId,
  onClose,
  onCreated,
}: {
  initialMrId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const ready = useResource<ReadyMr[]>('/api/mr/ready-for-pr');

  const [mrId, setMrId] = useState(initialMrId ?? '');
  const mr = useResource<MrView>(mrId ? `/api/mr/${mrId}` : null, [mrId]);

  const [procurementType, setProcurementType] = useState('MATERIAL');
  const [purpose, setPurpose] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [rates, setRates] = useState<Record<number, { rate: string; gst: string }>>({});
  const [terms, setTerms] = useState<Record<string, string>>({ ...ZERO_TERMS, pay_post_delivery_pct: '100' });
  const [override, setOverride] = useState('');

  // Only the lines with something left to buy. A line met entirely by transfer
  // has a zero purchase balance and does not belong on a PR.
  const lines = useMemo(
    () => (mr.data?.lines ?? []).filter(l => Number(l.qty_purchase) > 0),
    [mr.data],
  );

  const create = useMutation(
    async () =>
      api.post('/api/pr', {
        mr_id: Number(mrId),
        procurement_type: procurementType,
        purpose,
        expected_delivery: expectedDelivery,
        payment_terms: terms,
        payment_terms_override: override || null,
        lines: lines.map(l => ({
          mr_line_id: l.id,
          est_rate: rates[l.id]?.rate ?? '0',
          gst_rate: rates[l.id]?.gst ?? l.default_gst_rate ?? '18',
        })),
      }),
    { onDone: onCreated, successMessage: 'Purchase request raised.' },
  );

  const termsTotal = TERMS.reduce((s, t) => s + (Number(terms[t.key]) || 0), 0);
  const termsUnbalanced = Math.abs(termsTotal - 100) > 0.001 && !override.trim();

  // An indication, not the total. The authoritative figure is v_pr_totals, and
  // it is computed on the server once the request exists.
  const estimate = lines.reduce((sum, l) => {
    const rate = Number(rates[l.id]?.rate ?? 0);
    const gst = Number(rates[l.id]?.gst ?? l.default_gst_rate ?? 18);
    return sum + Number(l.qty_purchase) * rate * (1 + gst / 100);
  }, 0);

  const err = (field: string) => (create.fieldError?.field === field ? create.fieldError.message : null);
  const ratesMissing = lines.some(l => !rates[l.id]?.rate);

  return (
    <Card
      title="New purchase request"
      label="New purchase request"
      right={<button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>}
    >
      <form
        className="pad"
        onSubmit={e => {
          e.preventDefault();
          void create.run(undefined);
        }}
      >
        {create.error && <Banner kind="bad">{create.error}</Banner>}

        <div className="grid g3">
          <div className="field">
            <label htmlFor="pr-mr">From material request</label>
            <select id="pr-mr" className="inp" value={mrId} onChange={e => setMrId(e.target.value)} required>
              <option value="">Choose an approved request…</option>
              {(ready.data ?? []).map(m => (
                <option key={m.id} value={m.id}>
                  {m.mr_no} — {m.site_name}
                </option>
              ))}
            </select>
            {ready.data?.length === 0 && (
              <span className="sub">
                No approved requests are waiting. A request appears here once it is approved and still has
                something left to buy.
              </span>
            )}
            {err('mr_id') && <FieldError id="pr-mr">{err('mr_id')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="pr-type">Type</label>
            <select id="pr-type" className="inp" value={procurementType} onChange={e => setProcurementType(e.target.value)}>
              {ENUMS.procurement_type.map(t => (
                <option key={t} value={t}>{t.toLowerCase()}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="pr-delivery">Wanted by</label>
            <input
              id="pr-delivery"
              className="inp"
              type="date"
              value={expectedDelivery}
              onChange={e => setExpectedDelivery(e.target.value)}
              required
            />
            {err('expected_delivery') && <FieldError id="pr-delivery">{err('expected_delivery')}</FieldError>}
          </div>
        </div>

        <div className="field">
          <label htmlFor="pr-purpose">Purpose</label>
          <textarea
            id="pr-purpose"
            className="inp"
            rows={3}
            value={purpose}
            onChange={e => setPurpose(e.target.value)}
            required
            minLength={10}
            maxLength={1000}
            placeholder="What this buys and why it is being bought now."
          />
          {err('purpose') && <FieldError id="pr-purpose">{err('purpose')}</FieldError>}
        </div>

        {mrId && lines.length > 0 && (
          <>
            <h4 style={{ margin: '18px 0 8px' }}>What will be bought</h4>
            <div className="tbl">
              <div className="tr th" style={{ gridTemplateColumns: '1fr 120px 130px 100px 130px' }}>
                <div>Item</div>
                <div className="r">Quantity</div>
                <div className="r">Estimated rate</div>
                <div className="r">GST %</div>
                <div className="r">Line total</div>
              </div>
              {lines.map(l => {
                const rate = rates[l.id]?.rate ?? '';
                const gst = rates[l.id]?.gst ?? l.default_gst_rate ?? '18';
                const lineTotal = Number(l.qty_purchase) * Number(rate || 0) * (1 + Number(gst) / 100);

                return (
                  <div key={l.id} className="tr" style={{ gridTemplateColumns: '1fr 120px 130px 100px 130px' }}>
                    <div>
                      <span className="mono">{l.item_code}</span>
                      <div className="sub">{l.item_name}</div>
                    </div>
                    <div className="r">
                      {fmtQty(l.qty_purchase)} <span className="sub">{l.uom}</span>
                    </div>
                    <div className="r">
                      <label htmlFor={`pr-rate-${l.id}`} className="sr-only">Estimated rate for {l.item_code}</label>
                      <input
                        id={`pr-rate-${l.id}`}
                        className="inp-sm"
                        inputMode="decimal"
                        value={rate}
                        placeholder="0.00"
                        required
                        onChange={e => setRates(r => ({ ...r, [l.id]: { rate: e.target.value, gst } }))}
                      />
                    </div>
                    <div className="r">
                      <label htmlFor={`pr-gst-${l.id}`} className="sr-only">GST rate for {l.item_code}</label>
                      <input
                        id={`pr-gst-${l.id}`}
                        className="inp-sm"
                        inputMode="decimal"
                        value={gst}
                        onChange={e => setRates(r => ({ ...r, [l.id]: { rate, gst: e.target.value } }))}
                      />
                    </div>
                    <div className="r">{rate ? `₹${fmtMoney(lineTotal)}` : <span className="sub">—</span>}</div>
                  </div>
                );
              })}
            </div>
            <p className="sub">
              Roughly ₹{fmtMoney(estimate)} including GST. The binding figure comes from v_pr_totals once
              the request is saved.
            </p>
          </>
        )}

        {mrId && mr.data && lines.length === 0 && (
          <Banner kind="warn">
            Nothing is left to buy on this request — it was met entirely by transfer.
          </Banner>
        )}

        <h4 style={{ margin: '18px 0 8px' }}>Payment terms</h4>
        <div className="grid g3">
          {TERMS.map(t => (
            <div className="field" key={t.key}>
              <label htmlFor={`pr-${t.key}`}>{t.label} %</label>
              <input
                id={`pr-${t.key}`}
                className="inp"
                inputMode="decimal"
                value={terms[t.key]}
                onChange={e => setTerms(prev => ({ ...prev, [t.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
          <span className={Math.abs(termsTotal - 100) > 0.001 ? 'chip warn' : 'chip ok'}>{termsTotal}% of payment</span>
          {Math.abs(termsTotal - 100) > 0.001 && (
            <span className="sub">These must total 100%, or explain below why they cannot.</span>
          )}
        </div>

        {Math.abs(termsTotal - 100) > 0.001 && (
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="pr-override">Why the terms cannot be percentages</label>
            <input
              id="pr-override"
              className="inp"
              value={override}
              onChange={e => setOverride(e.target.value)}
              maxLength={500}
              placeholder="e.g. milestone-based, per the signed contract"
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={create.busy || !mrId || lines.length === 0 || ratesMissing || termsUnbalanced}
          >
            {create.busy ? 'Raising…' : 'Raise purchase request'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
