'use client';

/**
 * Log a delivery at the gate.
 *
 * The counted quantity is typed by the person counting, and is recorded as
 * typed. Where it exceeds the challan the excess is shown immediately — but as
 * information, not as an error, because the count is the fact and the argument
 * about it happens later (C-09).
 *
 * There is no "temperature in tolerance" field. The band comes from the item
 * classes on the order and the verdict is derived server-side (C-11); the form
 * only collects the reading.
 */
import { useMemo, useState } from 'react';
import { Banner, Card, FieldError, fmtQty } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useMutation, useResource } from '@/lib/client/use-resource';

interface ExpectedPo {
  id: number;
  po_no: string;
  vendor_name: string;
  site_name: string;
  expected_delivery: string;
  qty_outstanding: string | null;
}

interface PoLine {
  id: number;
  item_code: string;
  item_name: string;
  uom: string;
  qty_ordered: string;
  qty_outstanding: string | null;
}

interface PoView {
  po: { id: number; po_no: string; vendor_name: string };
  lines: PoLine[];
}

interface Counted {
  challan: string;
  counted: string;
}

export function NewGateInwardForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const expected = useResource<ExpectedPo[]>('/api/po/expected-deliveries');

  const [poId, setPoId] = useState('');
  const po = useResource<PoView>(poId ? `/api/po/${poId}` : null, [poId]);

  const [vehicleNo, setVehicleNo] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [challanDate, setChallanDate] = useState('');
  const [transporter, setTransporter] = useState('');
  const [driverName, setDriverName] = useState('');
  const [lrNo, setLrNo] = useState('');
  const [sealNo, setSealNo] = useState('');
  const [setPoint, setSetPoint] = useState('');
  const [actualTemp, setActualTemp] = useState('');
  const [counts, setCounts] = useState<Record<number, Counted>>({});

  // Only lines with something still owed. A fully received line has nothing
  // left to deliver, and offering it invites an over-receipt.
  const lines = useMemo(
    () => (po.data?.lines ?? []).filter(l => l.qty_outstanding === null || Number(l.qty_outstanding) > 0),
    [po.data],
  );

  const create = useMutation(
    async () =>
      api.post('/api/gate-inward', {
        po_id: Number(poId),
        vehicle_no: vehicleNo,
        challan_no: challanNo,
        challan_date: challanDate,
        transporter: transporter || null,
        driver_name: driverName || null,
        lr_no: lrNo || null,
        seal_no: sealNo || null,
        reefer_set_point_c: setPoint || null,
        reefer_actual_c: actualTemp || null,
        lines: lines
          .filter(l => counts[l.id]?.counted !== undefined && counts[l.id]?.counted !== '')
          .map(l => ({
            po_line_id: l.id,
            qty_per_challan: counts[l.id]?.challan || '0',
            qty_counted: counts[l.id]?.counted || '0',
          })),
      }),
    { onDone: onCreated, successMessage: 'Delivery logged.' },
  );

  const err = (field: string) => (create.fieldError?.field === field ? create.fieldError.message : null);
  const anyCounted = lines.some(l => counts[l.id]?.counted);

  const setCount = (id: number, patch: Partial<Counted>) =>
    setCounts(c => {
      const existing = c[id] ?? { challan: '', counted: '' };
      return { ...c, [id]: { ...existing, ...patch } };
    });

  return (
    <Card
      title="Log a delivery"
      label="Log a delivery"
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
            <label htmlFor="gi-po">Against which order?</label>
            <select id="gi-po" className="inp" value={poId} onChange={e => setPoId(e.target.value)} required>
              <option value="">Choose an expected delivery…</option>
              {(expected.data ?? []).map(p => (
                <option key={p.id} value={p.id}>
                  {p.po_no} — {p.vendor_name}
                </option>
              ))}
            </select>
            {expected.data?.length === 0 && (
              <span className="sub">Nothing is outstanding. Only issued orders take deliveries.</span>
            )}
            {err('po_id') && <FieldError id="gi-po">{err('po_id')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="gi-vehicle">Vehicle number</label>
            <input
              id="gi-vehicle"
              className="inp mono"
              value={vehicleNo}
              onChange={e => setVehicleNo(e.target.value)}
              required
              placeholder="WB 23 AB 4567"
            />
            <span className="sub">Spaces and case are tidied up automatically.</span>
            {err('vehicle_no') && <FieldError id="gi-vehicle">{err('vehicle_no')}</FieldError>}
          </div>

          <div className="field">
            <label htmlFor="gi-transporter">Transporter</label>
            <input id="gi-transporter" className="inp" value={transporter} onChange={e => setTransporter(e.target.value)} maxLength={120} />
          </div>
        </div>

        <div className="grid g4">
          <div className="field">
            <label htmlFor="gi-challan">Challan number</label>
            <input id="gi-challan" className="inp" value={challanNo} onChange={e => setChallanNo(e.target.value)} required maxLength={80} />
            {err('challan_no') && <FieldError id="gi-challan">{err('challan_no')}</FieldError>}
          </div>
          <div className="field">
            <label htmlFor="gi-challan-date">Challan date</label>
            <input id="gi-challan-date" className="inp" type="date" value={challanDate} onChange={e => setChallanDate(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="gi-driver">Driver</label>
            <input id="gi-driver" className="inp" value={driverName} onChange={e => setDriverName(e.target.value)} maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="gi-lr">LR number</label>
            <input id="gi-lr" className="inp" value={lrNo} onChange={e => setLrNo(e.target.value)} maxLength={80} />
          </div>
        </div>

        <div className="grid g3">
          <div className="field">
            <label htmlFor="gi-seal">Seal number</label>
            <input id="gi-seal" className="inp" value={sealNo} onChange={e => setSealNo(e.target.value)} maxLength={80} />
          </div>
          <div className="field">
            <label htmlFor="gi-setpoint">Reefer set point (°C)</label>
            <input id="gi-setpoint" className="inp" inputMode="decimal" value={setPoint} onChange={e => setSetPoint(e.target.value)} placeholder="-18" />
          </div>
          <div className="field">
            <label htmlFor="gi-actual">Reefer reading (°C)</label>
            <input id="gi-actual" className="inp" inputMode="decimal" value={actualTemp} onChange={e => setActualTemp(e.target.value)} placeholder="-17.5" />
            <span className="sub">Required for cold-chain cargo. Whether it is in band is decided by the item class, not here.</span>
            {err('reefer_actual_c') && <FieldError id="gi-actual">{err('reefer_actual_c')}</FieldError>}
          </div>
        </div>

        {poId && lines.length > 0 && (
          <>
            <h4 style={{ margin: '18px 0 8px' }}>Count what arrived</h4>
            <div className="tbl">
              <div className="tr th" style={{ gridTemplateColumns: '1fr 120px 130px 130px 110px' }}>
                <div>Item</div>
                <div className="r">Outstanding</div>
                <div className="r">Per challan</div>
                <div className="r">Counted</div>
                <div className="r">Difference</div>
              </div>
              {lines.map(l => {
                const row = counts[l.id] ?? { challan: '', counted: '' };
                const diff = Number(row.counted || 0) - Number(row.challan || 0);

                return (
                  <div key={l.id} className="tr" style={{ gridTemplateColumns: '1fr 120px 130px 130px 110px' }}>
                    <div>
                      <span className="mono">{l.item_code}</span>
                      <div className="sub">{l.item_name}</div>
                    </div>
                    <div className="r sub">
                      {fmtQty(l.qty_outstanding ?? l.qty_ordered)} {l.uom}
                    </div>
                    <div className="r">
                      <label htmlFor={`gi-ch-${l.id}`} className="sr-only">Quantity per challan for {l.item_code}</label>
                      <input
                        id={`gi-ch-${l.id}`}
                        className="inp-sm"
                        inputMode="decimal"
                        value={row.challan}
                        onChange={e => setCount(l.id, { challan: e.target.value })}
                      />
                    </div>
                    <div className="r">
                      <label htmlFor={`gi-ct-${l.id}`} className="sr-only">Quantity counted for {l.item_code}</label>
                      <input
                        id={`gi-ct-${l.id}`}
                        className="inp-sm"
                        inputMode="decimal"
                        value={row.counted}
                        onChange={e => setCount(l.id, { counted: e.target.value })}
                      />
                    </div>
                    <div className="r">
                      {!row.counted || !row.challan ? (
                        <span className="sub">—</span>
                      ) : diff === 0 ? (
                        <span className="chip ok">matches</span>
                      ) : diff < 0 ? (
                        <span className="chip warn">short {fmtQty(-diff)}</span>
                      ) : (
                        <span className="chip warn">excess {fmtQty(diff)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="sub">
              Record what you counted, even above the challan. A short line raises a shortfall case when the
              delivery goes to QC; an excess is stopped later, at goods receipt.
            </p>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button type="submit" className="btn btn-primary" disabled={create.busy || !poId || !anyCounted}>
            {create.busy ? 'Logging…' : 'Log the delivery'}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
