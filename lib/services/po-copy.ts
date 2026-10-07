/**
 * The system's own copy of a purchase order.
 *
 * Rendered from the record, never typed, and filed through the ordinary
 * documents path — so the copy gets the same SHA-256 on store, the same
 * re-hash-and-refuse on every download, and the same eight-year retention
 * class as anything a person uploads. A PO copy that lived outside that
 * machinery would be the one document nobody could prove had not been edited.
 *
 * It is generated AFTER the issue transaction commits. The alternative — doing
 * it inside — would mean a broken font or a full disk could roll back an order
 * that was otherwise perfectly valid, which is the wrong way round: the order
 * is the fact, the copy is a rendering of it. If filing fails the order still
 * stands and `filePoCopy()` can be called again from the screen.
 */
import PDFDocument from 'pdfkit';
import { getPo } from '@/lib/services/po';
import { uploadDocument } from '@/lib/services/documents';
import { sql } from '@/lib/db';
// The shared Actor, not a local copy — its ip is optional, and redefining it
// here made this the one service with a stricter signature than the rest.
import type { Actor } from '@/lib/services/masters';

type Row = Record<string, unknown>;

/** Its own type, so it is never confused with the signed copy a vendor returns. */
export const PO_COPY_TYPE = 'PO_COPY';

const money = (v: unknown): string =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const date = (v: unknown): string =>
  v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** Render the order as an A4 PDF. Pure: it reads, it returns bytes, it stores nothing. */
export async function renderPoCopy(poId: number): Promise<{ bytes: Buffer; fileName: string }> {
  const { po, lines } = await getPo(poId);

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: String(po.po_no) } });
  const chunks: Buffer[] = [];
  doc.on('data', c => chunks.push(c as Buffer));
  const done = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = 40;
  const right = 555;
  const line = (y: number) => doc.moveTo(left, y).lineTo(right, y).strokeColor('#cccccc').stroke();

  // --- who is buying -------------------------------------------------------
  doc.fontSize(16).font('Helvetica-Bold').text(String(po.site_name), left, 40);
  doc.fontSize(9).font('Helvetica').fillColor('#444444')
    .text(String(po.site_address ?? ''), { width: 300 })
    .text(`GSTIN ${po.site_gstin ?? '—'}`);

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#000000')
    .text('PURCHASE ORDER', 300, 40, { width: 255, align: 'right' });
  doc.fontSize(10).font('Helvetica')
    .text(String(po.po_no), { width: 255, align: 'right' })
    .text(`Issued ${date(po.issued_at)}`, { width: 255, align: 'right' })
    .text(`Tally ${po.tally_po_ref ?? '—'}`, { width: 255, align: 'right' });

  line(118);

  // --- who is selling ------------------------------------------------------
  doc.fontSize(8).font('Helvetica').fillColor('#666666').text('VENDOR', left, 130);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000').text(String(po.vendor_name), left, 142);
  doc.fontSize(9).font('Helvetica').fillColor('#444444')
    .text(String(po.vendor_address ?? ''), { width: 260 })
    .text(`PAN ${po.vendor_pan ?? '—'}`)
    // An unregistered vendor is a real thing, not missing data — say so plainly
    // on the order rather than leaving a blank somebody has to chase.
    .text(po.vendor_gstin ? `GSTIN ${po.vendor_gstin}` : 'GSTIN — unregistered, reverse charge may apply');

  doc.fontSize(8).fillColor('#666666').text('AGAINST', 320, 130);
  doc.fontSize(9).fillColor('#444444')
    .text(`Request ${po.pr_no}`, 320, 142)
    .text(`Material request ${po.mr_no}`)
    .text(`Budget ${po.budget_code}`)
    .text(`Quote ${po.vendor_quote_ref ?? '—'}`)
    .text(`Wanted by ${date(po.expected_delivery)}`);

  line(222);

  // --- what is being bought ------------------------------------------------
  const cols = { no: left, item: 70, qty: 300, rate: 365, gst: 420, total: 470 };
  let y = 234;

  doc.fontSize(8).font('Helvetica-Bold').fillColor('#666666');
  doc.text('#', cols.no, y);
  doc.text('ITEM', cols.item, y);
  doc.text('QTY', cols.qty, y, { width: 55, align: 'right' });
  doc.text('RATE', cols.rate, y, { width: 50, align: 'right' });
  doc.text('GST', cols.gst, y, { width: 45, align: 'right' });
  doc.text('AMOUNT', cols.total, y, { width: 85, align: 'right' });
  y += 14;
  line(y);
  y += 8;

  for (const l of lines) {
    // A new page before the row rather than through the middle of it.
    if (y > 690) {
      doc.addPage();
      y = 50;
    }

    doc.fontSize(9).font('Helvetica').fillColor('#000000');
    doc.text(String(l.line_no), cols.no, y);
    doc.font('Courier').text(String(l.item_code), cols.item, y);
    doc.font('Helvetica').fillColor('#444444').fontSize(8)
      .text(String(l.item_name), cols.item, y + 11, { width: 220 });

    doc.fontSize(9).fillColor('#000000');
    doc.text(`${Number(l.qty_ordered)} ${l.uom}`, cols.qty, y, { width: 55, align: 'right' });
    doc.text(money(l.rate), cols.rate, y, { width: 50, align: 'right' });
    doc.text(`${Number(l.gst_rate)}%`, cols.gst, y, { width: 45, align: 'right' });
    doc.text(money(l.line_total), cols.total, y, { width: 85, align: 'right' });

    // A rate that departs from the awarded quotation carries its reason onto
    // the order itself — the remark exists so the departure is never silent.
    if (l.rate_deviation_remark) {
      doc.fontSize(8).fillColor('#8a6d00')
        .text(`Rate override: ${l.rate_deviation_remark}`, cols.item, y + 22, { width: 400 });
      y += 11;
    }

    y += 30;
  }

  line(y);
  y += 10;

  // --- what it comes to ----------------------------------------------------
  const taxable = lines.reduce((s, l) => s + Number(l.line_taxable ?? 0), 0);
  const gst = lines.reduce((s, l) => s + Number(l.line_gst ?? 0), 0);
  const freight = Number(po.freight_amount ?? 0);

  const total = (label: string, value: string, bold = false) => {
    doc.fontSize(bold ? 11 : 9).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000000');
    doc.text(label, cols.rate - 60, y, { width: 165, align: 'right' });
    doc.text(value, cols.total, y, { width: 85, align: 'right' });
    y += bold ? 18 : 14;
  };

  total('Taxable', money(taxable));
  total('GST', money(gst));
  total('Freight', money(freight));
  // The currency goes in the LABEL. Bold 11pt "INR 10,50,300.00" is wider than
  // the amount column and wrapped onto a second line, which on a total reads
  // as two numbers rather than one.
  total('Total (INR)', money(taxable + gst + freight), true);

  // --- on what terms -------------------------------------------------------
  y += 6;
  line(y);
  y += 10;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#666666').text('TERMS', left, y);
  y += 12;
  doc.fontSize(9).font('Helvetica').fillColor('#444444');
  const term = (label: string, value: unknown) => {
    doc.text(`${label}: ${value ?? '—'}`, left, y, { width: 515 });
    y += 13;
  };
  term('Payment', po.payment_terms);
  term('Warranty', po.warranty_months ? `${po.warranty_months} months` : '—');
  term('Freight', po.freight_terms);
  term('Installation', po.installation_terms);

  doc.fontSize(8).fillColor('#888888').text(
    `Raised by ${po.buyer_name}. Generated by Crystal Assets & Procurement from ${po.po_no} — ` +
    'this copy is rendered from the record and is not separately editable.',
    left, 780, { width: 515 },
  );

  doc.end();
  const bytes = await done;

  return { bytes, fileName: `${String(po.po_no).replace(/[\\/]/g, '-')}.pdf` };
}

/**
 * Render the copy and file it against the order.
 *
 * Replaces any copy already filed: the order can only be issued once, so a
 * second copy would just be two renderings of the same facts sitting beside
 * each other with nothing to tell them apart.
 */
export async function filePoCopy(actor: Actor, poId: number): Promise<Row> {
  const { bytes, fileName } = await renderPoCopy(poId);

  await sql`
    DELETE FROM documents
     WHERE entity_type = 'PO' AND entity_id = ${poId} AND doc_type = ${PO_COPY_TYPE}`;

  return uploadDocument(actor, {
    entityType: 'PO',
    entityId: poId,
    docType: PO_COPY_TYPE,
    fileName,
    mimeType: 'application/pdf',
    bytes,
  });
}
