# Screen → Entity → API Map

`P` = exists in prototype · `N` = net-new screen

---

## Prototype screens (15)

| # | Route | Screen | Primary tables | Views | Key APIs |
|---|---|---|---|---|---|
| P1 | `#main` | Warehouse stock | `stock_balances`, `item_site_settings` | `v_stock_position`, `v_group_surplus` | `GET /api/inventory/position` |
| P2 | `#ledger` | Stock ledger | `stock_ledger` | — | `GET /api/inventory/ledger` |
| P3 | `#damage` | Damaged & missing | `damage_reports`, `damage_inspections`, `shortfall_cases` | — | `GET/POST /api/damage`, `POST /api/damage/:id/inspect`, `POST /api/damage/:id/decision`, `POST /api/shortfalls/:id/decision` |
| P4 | `#mr` | New material request | `material_requests`, `mr_lines`, `mr_declarations`, `mr_allocations` | `v_group_surplus` | `POST /api/mr`, `POST /api/mr/:id/stock-check`, `POST /api/mr/:id/declare` |
| P5 | `#raisepr` | Raise purchase request | `purchase_requests`, `pr_lines` | `v_pr_totals` | `GET /api/mr?status=MR_APPROVED`, `POST /api/pr`, `POST /api/pr/:id/submit` |
| P6 | `#pr` | PR approval | `purchase_requests`, `approvals` | `v_pr_totals` | `POST /api/pr/:id/approve`, `POST /api/pr/:id/reject` |
| P7 | `#quotes` | Vendor quotations | `quotations`, `quotation_lines` | `v_quotation_landed_cost` | `GET/POST /api/pr/:id/quotations` |
| P8 | `#compare` | Comparison statement | `quote_awards` | `v_quotation_landed_cost`, `v_vendor_scorecard` | `GET /api/pr/:id/comparison`, `POST /api/pr/:id/award` |
| P9 | `#po` | Purchase order | `purchase_orders`, `po_lines` | — | `POST /api/po`, `POST /api/po/:id/issue` |
| P10 | `#gate` | Gate inward | `gate_inwards`, `gate_inward_lines` | `v_po_line_receipt` | `GET /api/po/expected`, `POST /api/gate-inward`, `POST /api/gate-inward/:id/reject` |
| P11 | `#qc` | QA/QC inspection | `qc_inspections`, `qc_lines`, `qc_line_checks`, `qc_hold_decisions` | — | `POST /api/qc`, `PATCH /api/qc/:id/lines`, `POST /api/qc/:id/hold-decision`, `POST /api/qc/:id/complete` |
| P12 | `#grn` | Goods receipt note | `grns`, `grn_lines`, `asset_units` | `v_po_line_receipt` | `POST /api/grn`, `POST /api/grn/:id/approve`, `POST /api/grn/:id/flag`, `POST /api/grn/:id/reject` |
| P13 | `#returns` | Purchase returns | `purchase_returns`, `purchase_return_lines` | — | `POST /api/returns`, `.../approve`, `.../dispatch`, `.../acknowledge`, `.../close` |
| P14 | `#notes` | Debit & credit notes | `debit_notes`, `vendor_credit_notes`, `debit_note_offsets` | — | `POST /api/debit-notes/:id/issue`, `POST /api/credit-notes`, `POST /api/debit-notes/:id/offset`, `POST /api/debit-notes/:id/reconcile` |
| P15 | `#recon` | Vendor reconciliation | `vendor_recon_runs`, `vendor_recon_items`, `vendor_ledger_entries` | — | `POST /api/reconciliation/runs`, `PATCH /api/reconciliation/items/:id`, `POST /api/reconciliation/runs/:id/close` |

## Net-new screens (~25)

| Group | Screens | Tables |
|---|---|---|
| Dashboard | `N1` Dashboard (§24, 6 metric groups), `N2` Pending approvals inbox | all views + `approvals` |
| Masters | `N3` Sites, `N4` Storage locations, `N5` Item classes, `N6` Items, `N7` Item-site settings, `N8` Budget codes, `N9` Approval bands + levels, `N10` User-site-roles, `N11` QC checklists + points, `N12` Email config | §1 tables, `qc_checklists` |
| Vendors | `N13` Vendor register, `N14` Vendor detail + KYC, `N15` Vendor approval queue, `N16` Bank accounts (maker-checker) | `vendors`, `vendor_bank_accounts`, `vendor_categories`, `vendor_sites` |
| Procurement | `N17` MR register, `N18` MR detail + approval, `N19` Transfer register, `N20` Transfer detail (request→approve→dispatch→receive), `N21` PR register, `N22` PO register | §3–6 |
| Receiving | `N23` Gate inward register, `N24` QC queue (SLA countdown), `N25` GRN approval queue, `N26` Shortfall register | §7 |
| Inventory | `N27` Stock issue, `N28` Asset register | `stock_issues`, `asset_units` |
| Accounts | `N29` Vendor invoice register + entry, `N30` Vendor ledger | `vendor_invoices`, `vendor_ledger_entries` |
| Platform | `N31` Audit trail viewer | `audit_log` |

Navigation gains three groups: **Dashboard** (top), **Masters** and **Vendors**
(bottom, `CG_ADM`-gated), keeping the prototype's existing four groups intact.

---

## API surface

All routes are `app/api/**/route.ts`, thin wrappers over `lib/services/*`.
Every mutating route: authenticate → authorise (permission + site scope) →
validate → `sql.begin` → audit → map errors → respond.

```
/api/auth/session              GET    current user, roles, sites, permissions
/api/dashboard                 GET    §24 metrics, ?scope=site|group
/api/dashboard/approvals       GET    pending approvals for the caller

/api/master/sites              GET POST          /:id GET PATCH
/api/master/locations          GET POST          /:id GET PATCH
/api/master/item-classes       GET POST          /:id GET PATCH
/api/master/items              GET POST          /:id GET PATCH
/api/master/item-site-settings GET PUT
/api/master/budget-codes       GET POST          /:id GET PATCH
/api/master/approval-bands     GET POST          /:id GET PATCH DELETE
/api/master/user-site-roles    GET POST DELETE
/api/master/qc-checklists      GET POST          /:id/publish POST
/api/master/email-config       GET PUT

/api/vendors                   GET POST          /:id GET PATCH
/api/vendors/:id/submit        POST              → VENDOR_PENDING
/api/vendors/:id/approve       POST              → VENDOR_APPROVED (needs tally_ledger_ref)
/api/vendors/:id/block         POST              → VENDOR_BLOCKED (reason required)
/api/vendors/:id/bank          GET POST          propose
/api/vendors/:id/bank/:bid/approve POST          maker-checker
/api/vendors/:id/categories    PUT
/api/vendors/:id/sites         PUT

/api/mr                        GET POST          /:id GET PATCH
/api/mr/:id/stock-check        POST              writes mr_lines.stock_check snapshot
/api/mr/:id/declare            POST              declaration + allocations (one tx)
/api/mr/:id/approve            POST              SoD: ≠ requester
/api/mr/:id/reject             POST              reason required
/api/mr/:id/cancel             POST

/api/transfers                 GET POST          /:id GET
/api/transfers/:id/approve     POST              holding site's CG_WHL
/api/transfers/:id/reject      POST              reason required
/api/transfers/:id/dispatch    POST              → stock movements
/api/transfers/:id/receive     POST              → stock movements

/api/pr                        GET POST          /:id GET PATCH
/api/pr/:id/submit             POST
/api/pr/:id/approve            POST              band-driven levels
/api/pr/:id/reject             POST
/api/pr/:id/cancel             POST

/api/pr/:id/quotations         GET POST          /:qid PATCH DELETE
/api/pr/:id/comparison         GET               v_quotation_landed_cost + scorecard
/api/pr/:id/award              POST              lowest | non-lowest (+justification) | waiver

/api/po                        GET POST          /:id GET PATCH
/api/po/:id/issue              POST              requires tally_po_ref
/api/po/:id/short-close        POST              reason required
/api/po/:id/cancel             POST
/api/po/expected               GET               open POs per site, for gate inward

/api/gate-inward               GET POST          /:id GET
/api/gate-inward/:id/reject    POST
/api/gate-inward/:id/to-qc     POST              → QC_PENDING

/api/qc                        GET POST          /:id GET
/api/qc/:id/lines              PATCH
/api/qc/:id/checks             PUT               checklist point results
/api/qc/:id/hold-decision      POST              CG_SMGR: concession | reject
/api/qc/:id/complete           POST              → QC_COMPLETED, drafts RTV
/api/qc/:id/reinspect          POST              new inspection, is_reinspection_of

/api/grn                       GET POST          /:id GET
/api/grn/:id/approve           POST              → post_stock_movement ×N
/api/grn/:id/flag              POST              reason required
/api/grn/:id/reject            POST              reason required

/api/shortfalls                GET               /:id GET
/api/shortfalls/:id/decision   POST              AWAIT_BALANCE | SHORT_CLOSE

/api/inventory/position        GET               v_stock_position
/api/inventory/ledger          GET               stock_ledger, filtered + paged
/api/inventory/surplus         GET               v_group_surplus
/api/inventory/issues          GET POST          → ISSUE movements
/api/inventory/assets          GET               /:id GET PATCH

/api/damage                    GET POST          /:id GET
/api/damage/:id/inspect        POST              CG_SMGR + CG_QC, neither the reporter
/api/damage/:id/decision       POST              REPAIR | WARRANTY | WRITE_OFF
/api/damage/:id/repair-complete POST             → REPAIR_COMPLETE movement

/api/returns                   GET POST          /:id GET
/api/returns/:id/approve       POST              SoD: ≠ raiser; mints PRN + gate pass
/api/returns/:id/dispatch      POST              reversal movement if stock entered
/api/returns/:id/acknowledge   POST
/api/returns/:id/close         POST
/api/returns/:id/cancel        POST

/api/invoices                  GET POST          /:id GET PATCH
/api/invoices/:id/match        POST              three-way match
/api/invoices/:id/hold         POST
/api/invoices/:id/release      POST
/api/invoices/:id/dispute      POST

/api/debit-notes               GET               /:id GET
/api/debit-notes/:id/issue     POST              requires tally_voucher_ref path
/api/debit-notes/:id/offset    POST              against an open invoice
/api/debit-notes/:id/reconcile POST              blocked while variance flagged
/api/credit-notes              POST              /:id GET

/api/reconciliation/runs       GET POST          /:id GET
/api/reconciliation/items/:id  PATCH             resolve / map
/api/reconciliation/runs/:id/close POST          requires portal = tally
/api/reconciliation/import     POST              Tally ledger import

/api/approvals                 GET               inbox
/api/approvals/:id/decide      POST              generic engine
/api/audit                     GET               filtered, read-only
/api/documents                 POST GET          upload / download, sha256
```

**Idempotency.** Every `POST` that posts stock or mints a document number accepts
an `Idempotency-Key` header. The stock layer is already idempotent through
`post_stock_movement()`; the header protects document-number minting and
multi-step operations from double submission.

---

## Validation rules — where each is enforced

| Rule | DB | Service | Client |
|---|:--:|:--:|:--:|
| `qty_purchase = qty_requested − qty_transfer` | generated column | ✓ | preview |
| PR line qty = MR purchase balance | `check_pr_line_qty()` | ✓ | locked field |
| Payment percentages total 100 | `pr_payment_terms_total` | ✓ | live total |
| Allocation totals 100 | `check_allocation_total()` | ✓ | live total |
| `accepted + hold + rejected = delivered` | `qc_lines_sum` | ✓ | per-row badge |
| Reason required for hold/reject | `qc_lines_reason` | ✓ | conditional field |
| PR locked after approval | `pr_edit_lock()` | ✓ | read-only |
| PO vendor approved | `check_po_vendor()` | ✓ | filtered list |
| PO issue needs Tally ref | `po_issue_needs_tally` | ✓ | disabled button |
| QC inspector ≠ receiver | `check_qc_segregation()` | ✓ | hidden action |
| GRN approver ∉ {receiver, inspector} | `check_grn_segregation()` | ✓ | hidden action |
| MR/RTV approver ≠ originator | CHECK | ✓ | hidden action |
| **PR approver ≠ requester** | — (C-16) | ✓ | hidden action |
| Bank maker ≠ checker | `vba_maker_checker` | ✓ | hidden action |
| One live bank account | `vba_one_live` | ✓ | — |
| PAN / GSTIN format + linkage | CHECK + regex | ✓ | inline |
| Duplicate PAN / GSTIN | unique index | ✓ | async check |
| Duplicate invoice no. per vendor | unique index | ✓ | async check |
| GST: IGST xor CGST+SGST | `vi_tax_mode`, `dn_tax_mode` | ✓ | derived from state |
| Duplicate active challan per PO | partial unique index | ✓ | async check |
| Vehicle format | `gi_vehicle_format` | ✓ (normalise) | inline |
| Transfer sites differ | `trf_sites_differ` | ✓ | filtered list |
| Stock never negative | `qty >= 0` CHECK | ✓ | available shown |
| Quotes ≥ minimum or waiver | `awards_waiver` | ✓ | conditional field |
| Non-lowest needs justification | `awards_nonlow` | ✓ | conditional field |
| Warranty claim needs in-warranty | `dmg_warranty_claim` | ✓ | disabled option |
| Write-off > ₹50k needs insurance ref | `dmg_insurance_ref` | ✓ | conditional field |
| RTV exactly one source | `rtv_one_source` | ✓ | — |
| DN exactly one source | `dn_one_source` | ✓ | — |
| **CN variance blocks closure** | — (C-14) | ✓ | disabled button |
| Recon closes only at zero | `recon_zero_to_close` | ✓ | disabled button |

---

## Stock movement rules

| Event | Movement | Site | From → To | Source |
|---|---|---|---|---|
| Opening balance load | `OPENING` | site | `NULL → AVAILABLE` | `OPENING` |
| GRN approved | `GRN_RECEIPT` | receiving | `NULL → AVAILABLE` | `GRN_LINE` |
| Stock issued | `ISSUE` | site | `AVAILABLE → NULL` | `ISSUE_LINE` |
| Transfer approved | `TRANSFER_RESERVE` | source | `AVAILABLE → RESERVED` | `TRANSFER_LINE` |
| Transfer dispatched | `TRANSFER_OUT` | source | `RESERVED → IN_TRANSIT` | `TRANSFER_LINE` |
| Transfer received (leg 1) | `TRANSFER_IN` | source | `IN_TRANSIT → NULL` | `TRANSFER_LINE` |
| Transfer received (leg 2) | `TRANSFER_IN` | destination | `NULL → AVAILABLE` | `TRANSFER_LINE` |
| Damage quarantined | `DAMAGE_QUARANTINE` | site | `AVAILABLE → DAMAGED_HOLD` | `DAMAGE_REPORT` |
| Repair started | `REPAIR_START` | site | `DAMAGED_HOLD → UNDER_REPAIR` | `DAMAGE_REPORT` |
| Repair completed | `REPAIR_COMPLETE` | site | `UNDER_REPAIR → AVAILABLE` | `DAMAGE_REPORT` |
| Written off | `WRITE_OFF` | site | `DAMAGED_HOLD → WRITTEN_OFF` | `DAMAGE_REPORT` |
| RTV dispatched (damage source) | `RTV_REVERSAL` | site | `DAMAGED_HOLD → NULL` | `RTV_LINE` |
| Correction | `REVERSAL` | site | mirror of original, `reverses_entry_id` set | original source |
| Manual adjustment | `ADJUSTMENT` | site | as counted | `ADJUSTMENT` |

**Never posts stock:** QC rejection (never entered stock) and shortfall (never
arrived). Both are recovered financially via RTV/debit note only.

The two `TRANSFER_IN` legs depend on conflict **C-01** being resolved.
