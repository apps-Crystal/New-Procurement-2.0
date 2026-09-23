# Crystal Procurement 2.0 — Architecture & Module Map

**Phase 1 deliverable. No application code has been written yet.**

Sources analysed:

| Source | What it is | Authority |
|---|---|---|
| `db/crystal_procurement_schema.sql` (1,284 lines) | PostgreSQL 15+ schema, ref. CG-PROC-BSOP-003 v2.0 | **Authoritative for data model + business constraints** |
| `prototype/index.html` (104 KB, 15 screens) | Single-file clickable prototype, vanilla JS | **Authoritative for UI/UX intent** |
| `prototype/canvas-source/*.dc.html` (16 files) | Design-canvas component sources, reference only | Visual reference |
| Crystal Procurement v1.0 (`CRYSTAL NEW PROCUREMENT/crystal-procurement-main`) | Live predecessor app: Next.js 16, React 19, `postgres.js`, Tailwind 4 | **House conventions for SSO, session, DB access** |

The schema refers to v1.0 throughout (`is_legacy_v1`, "v1.0 rule carried forward",
"fixes the v1.0 read-increment-write race"), so v1.0 is the direct predecessor of
this system, not an unrelated project.

---

## 1. System shape

```
Crystal Core (identity provider, external)
        │  short-lived launch JWT
        ▼
   /sso  ──► verify with Core ──► mirror into app_users ──► signed session cookie
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  Next.js app                                                │
│                                                             │
│   app/(screens)     React Server Components + client islands│
│   app/api/*         route handlers — thin, no business logic│
│   lib/services/*    business logic, one module per domain   │
│   lib/db.ts         postgres.js client + sql.begin()        │
│   lib/auth/*        session, current user, permissions      │
│   lib/errors.ts     PG error code → business message        │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
  PostgreSQL 15+   ── constraints, triggers, views, functions
                      post_stock_movement(), next_document_no()
```

**Layering rule.** Route handler → service → `sql.begin(tx => …)`. Route handlers
parse/authorise/serialise only. Services own transactions, validation, and audit
writes. Nothing outside `lib/db.ts` opens a connection; nothing outside
`lib/services/*` writes to a table.

**Stock rule.** No code anywhere issues `INSERT INTO stock_ledger` or
`UPDATE stock_balances`. Every movement goes through `post_stock_movement()`.
This is enforced by review plus a test that greps the source tree.

---

## 2. Module map

| # | Module | Schema section | Prototype screens | Net-new screens needed |
|---|---|---|---|---|
| 0 | Platform (auth, audit, documents, notifications, numbering) | §11, `id_counters` | — | Audit trail viewer |
| 1 | Master data | §1 | — | Sites, Locations, Items, Item classes, Budget codes, Approval bands, User-site-roles, QC checklists |
| 2 | Vendor management | §1 (vendors…) | — | Vendor list, Vendor detail, Vendor approval, Bank maker-checker |
| 3 | Material request + stock check + transfer | §3 | `#mr` | MR list, MR detail, Declaration, Transfer list/detail |
| 4 | Purchase request | §4 | `#raisepr`, `#pr` | PR list |
| 5 | Quotations, comparison, award | §5 | `#quotes`, `#compare` | — |
| 6 | Purchase order | §6 | `#po` | PO list |
| 7 | Receiving — gate inward, QC, GRN, shortfall | §7 | `#gate`, `#qc`, `#grn` | GI list, QC queue, GRN queue, Shortfall list |
| 8 | Inventory — ledger, balances, assets, issues | §2 | `#main`, `#ledger` | Stock issue, Asset register |
| 9 | Damage | §8 | `#damage` | Damage report form, Repair tracking |
| 10 | Purchase returns (RTV) | §9 | `#returns` | RTV create form |
| 11 | Accounts — invoices, DN, CN, recon | §10 | `#notes`, `#recon` | Vendor invoice entry, Vendor ledger |
| 12 | Dashboard & reporting | §12 views | — | **Entire dashboard (§24)** |

**15 prototype screens → ~40 screens in production.** The prototype covers the
transaction happy path only. Every master-data screen, every list/queue screen,
and the whole dashboard are net-new and must be designed in the prototype's
visual language (tokens in §6 below).

---

## 3. Database entity map (61 tables, 6 views, 8 functions)

### Identity & master data (§1)
```
app_users ──< user_site_roles >── sites ──< storage_locations
                                    │
                                    ├──< budget_codes
                                    └──< item_site_settings >── items ──> item_classes
approval_bands ──< approval_band_levels
vendors ──< vendor_bank_accounts        (maker-checker, one live)
        ├──< vendor_categories >── item_classes
        └──< vendor_sites >── sites
id_counters                              (atomic document numbering)
```

### Inventory (§2)
```
stock_ledger   append-only, trigger-enforced, idempotency_key UNIQUE
stock_balances projection, PK (site_id, item_id, bucket), CHECK qty >= 0
asset_units    serialised units, FK → grn_lines
stock_issues ──< stock_issue_lines
```

### Procurement (§3–6)
```
material_requests ──< mr_lines
        ├──< mr_declarations ──< mr_allocations   (sum = 100%, deferred trigger)
        └──< stock_transfers ──< stock_transfer_lines
                │
purchase_requests ──< pr_lines          (mr_id NOT NULL — PR cannot exist without MR)
        ├──< quotations ──< quotation_lines
        ├──< quote_awards                (pr_id UNIQUE — one award per PR)
        └──< purchase_orders ──< po_lines  (pr_id UNIQUE — one PO per PR)
approvals        generic trail: (entity_type, entity_id, level_no) UNIQUE
```

### Receiving (§7)
```
purchase_orders ──< gate_inwards ──< gate_inward_lines
                          │                  │
                          │                  └──< shortfall_cases  (1:1, UNIQUE)
                          └──1:1── qc_inspections ──< qc_lines ──< qc_line_checks
                                        │                 └──1:1── qc_hold_decisions
                                        │
                                        └──1:1── grns ──< grn_lines
qc_checklists ──< qc_checklist_points   (versioned, one current per item class)
```

### Damage & returns (§8–9)
```
damage_reports ──< damage_inspections
purchase_returns ──< purchase_return_lines
   source = QC_REJECTION | WAREHOUSE_DAMAGE | SHORTFALL  (exactly one FK set)
```

### Accounts (§10)
```
vendor_invoices ──< debit_note_offsets >── debit_notes ──< vendor_credit_notes
                                              (rtv_id XOR shortfall_id)
vendor_ledger_entries  (side = PORTAL | TALLY)
vendor_recon_runs ──< vendor_recon_items
```

### Platform (§11)
```
documents, email_config ──< notification_outbox, status_transitions, audit_log
```

### Views (authoritative calculations — never re-implement in app code)
| View | Purpose | Replaces prototype JS |
|---|---|---|
| `v_pr_totals` | PR taxable / GST / total incl. delivery | `prGoods()`, `prTotal()` |
| `v_quotation_landed_cost` | Landed cost **and rank** per quotation | `landed()`, `ranks()` |
| `v_po_line_receipt` | Received / outstanding per PO line | — |
| `v_stock_position` | Stock by bucket + reorder status | `SCREENS.main` inline arrays |
| `v_group_surplus` | Group-wide surplus above reorder | MR stock-check hints |
| `v_vendor_scorecard` | Rejection %, returns 12m | `#compare` hardcoded scorecard |

### Functions
| Function | Contract |
|---|---|
| `next_document_no(entity, site_code, at)` | Atomic, `ENT-SITE-MonYYYY/0001`. **Only** source of document numbers. |
| `post_stock_movement(...)` | **Only** way stock changes. Idempotent on `source_type:source_id:movement`. |
| `check_pr_line_qty()` | PR line qty must equal `mr_lines.qty_purchase` |
| `pr_edit_lock()` | Blocks edits once `locked_at` set |
| `check_po_vendor()` | PO vendor must be `VENDOR_APPROVED` |
| `check_qc_segregation()` | Inspector ≠ gate-inward receiver |
| `check_grn_segregation()` | Approver ∉ {receiver, inspector} |
| `check_allocation_total()` | MR allocations sum to 100% (deferred) |
| `compute_cn_variance()` | Credit-note variance %, flags > 2% |
| `site_code_immutable()` | Site code frozen once transacted |
| `forbid_mutation()` | Append-only guard on `stock_ledger`, `audit_log` |

---

## 4. State machines

**MR** (`mr_status`)
```
MR_DRAFT → MR_STOCK_CHECK → ┬ MR_STOCK_AVAILABLE   → MR_TRANSFER_REQUESTED → … → MR_FULFILLED_INTERNAL
                            ├ MR_STOCK_PARTIAL     → transfer AND declaration
                            └ MR_STOCK_UNAVAILABLE → MR_DECLARED → MR_APPROVED → MR_CONVERTED_TO_PR
                                                                 └ MR_REJECTED (reason required)
any → MR_CANCELLED
```
Guard: `mr_self_approval` — `approved_by <> requester_id`.

**Transfer** (`transfer_status`)
```
TRF_REQUESTED → TRF_APPROVED → TRF_DISPATCHED → TRF_RECEIVED
              └ TRF_REJECTED (reason required)
any → TRF_CANCELLED
```
Guard: `trf_sites_differ`.

**PR** (`pr_status`)
```
PR_DRAFT → PR_SUBMITTED → PR_APPROVED → PO_POSTED → PR_CLOSED
                        └ PR_REJECTED
any → PR_CANCELLED (reason required)
```
Guard: `locked_at` set on approval → `pr_edit_lock()` blocks field edits.

**PO** (`po_status`)
```
PO_DRAFT → PO_CREATED → PO_PARTIALLY_RECEIVED → PO_RECEIVED → PO_CLOSED
                                              └ PO_SHORT_CLOSED (reason required)
any → PO_CANCELLED
```
Guard: `po_issue_needs_tally` — anything past `PO_DRAFT` needs `tally_po_ref`.

**Gate inward** (`gate_status`)
```
INWARD_RECEIVED → QC_PENDING → QC_IN_PROGRESS → QC_COMPLETED
                └ INWARD_REJECTED (reason required)
```

**GRN** (`grn_status`)
```
GRN_DRAFT → GRN_APPROVED → GRN_CLOSED
          ├ GRN_REJECTED (reason required)
          └ GRN_FLAGGED  (reason required)
```
Only `GRN_APPROVED` / `GRN_CLOSED` count toward PO receipt (`v_po_line_receipt`).

**Damage** (`damage_status`)
```
DMG_REPORTED → DMG_INSPECTED → DMG_DECISION_PENDING_APPROVAL → ┬ DMG_UNDER_REPAIR  → DMG_CLOSED
                                                              ├ DMG_RETURN_RAISED → DMG_CLOSED
                                                              └ DMG_WRITTEN_OFF   → DMG_CLOSED
```

**RTV** (`rtv_status`)
```
RTV_DRAFT → RTV_APPROVED → RTV_DISPATCHED → RTV_ACKNOWLEDGED → RTV_CLOSED
any → RTV_CANCELLED
```
Guards: `rtv_self_approval`; `rtv_approved_docs` (PRN + gate pass required past draft).

**Invoice / DN / Recon**
```
INV_RECEIVED → INV_MATCHED → INV_PARTIALLY_HELD → INV_RELEASED → INV_PAID
             └ INV_DISPUTED

DEBIT_NOTE_PENDING → DEBIT_NOTE_ISSUED → CREDIT_NOTE_RECEIVED → DN_ADJUSTED → DN_RECONCILED
                                                                            └ DN_CANCELLED

RECON_OPEN → RECON_DIFFERENCE → RECON_RECONCILED → RECON_CONFIRMED_BY_VENDOR
```
Guards: `dn_reconciled_needs_tally`; `recon_zero_to_close` (portal = tally).

**`status_transitions` is shipped empty.** Every arrow above must be seeded into
it with a `permission_key`, because the schema states "the API rejects anything
not listed here". This is a required Phase 2 deliverable, not optional.

---

## 5. Role matrix

Schema roles (`role_code`): `CG_REQ`, `CG_SMGR`, `CG_BUY`, `CG_RCV`, `CG_QC`,
`CG_WHL`, `CG_ACC`, `CG_ADM`, `CG_FHEAD`, `CG_DIR`.

| Role | Reads as | Owns |
|---|---|---|
| `CG_REQ` | Requester | MR draft, declaration, PR draft |
| `CG_SMGR` | Site Manager | MR approval, QC hold decision, GRN approval, damage inspection |
| `CG_BUY` | Buyer | Quotations, comparison, award, PO |
| `CG_RCV` | Site Receiver | Gate inward, RTV dispatch |
| `CG_QC` | QA/QC Inspector | QC inspection, damage inspection |
| `CG_WHL` | Warehouse Lead | Transfer approve/dispatch, stock issue, damage decision, write-off L1 |
| `CG_ACC` | Accounts | Invoices, debit notes, credit notes, offsets, reconciliation |
| `CG_ADM` | Administrator | Master data, users, approval bands, checklists, email config |
| `CG_FHEAD` | Functional Head | PR approval L2, non-lowest award, write-off L2, CN short-credit override |
| `CG_DIR` | Director | PR approval L3 (> ₹10 lakh), quote waiver |

Prototype role names map as: "Head of Supply Chain" → `CG_FHEAD`,
"Head of Operations" → `CG_FHEAD`, "Head of Finance" → `CG_FHEAD`,
"Storekeeper" → `CG_WHL`. See conflict C-12.

**Scoping.** Every query is filtered by the caller's `user_site_roles.site_id`
set. `CG_ADM` and `CG_DIR` are group-wide. Permission checks are server-side in
the service layer; hiding a button is presentation only.

**Segregation of duties** (DB-enforced, listed so the UI can pre-empt them):

| Rule | Enforced by |
|---|---|
| MR approver ≠ requester | `mr_self_approval` CHECK |
| QC inspector ≠ gate receiver | `check_qc_segregation()` trigger |
| GRN approver ∉ {receiver, inspector} | `check_grn_segregation()` trigger |
| RTV approver ≠ raiser | `rtv_self_approval` CHECK |
| Bank approver ≠ proposer | `vba_maker_checker` CHECK |
| PR approver ≠ requester | **Not in schema — app-enforced.** See C-16 |

---

## 6. UI system (from the prototype — preserve exactly)

**Tokens** — full light/dark set on `:root`, dark via both
`@media (prefers-color-scheme: dark)` (guarded by `:root:not([data-theme="light"])`)
and `:root[data-theme="dark"]`. Palette: `--bg #F3F2EE`, `--surface #FFFFFF`,
`--ink #18202B`, `--accent #0B5F63`, `--nav-bg #18202B`, plus
ok/warn/bad/info/neutral pairs. Fonts: IBM Plex Sans + IBM Plex Mono.

**Components to port 1:1**: `.card` / `.card-h` / `.pad`, `.kpi`, `.tr`/`.th`
grid tables, `.btn` (44px min target) + `.btn-sm`, `.chip` status badges,
`.field`/`.inp`/`.inp-sm`, `.tile`, `.box`, `.banner`, `.steps` (numbered
progress), `.bars` (stage progress), `.kanban`/`.kcard`, `.list-btn`, `.pick`
(radio cards), `.doc` (printable document view), `.meter`, `.ph` (photo
placeholder), `#toast`.

**Status colour convention** (keep consistent across all 40 screens):

| Token | Used for |
|---|---|
| `ok` | approved, matched, healthy, balanced, in tolerance, reconciled |
| `warn` | pending decision, hold, flagged, near reorder, draft awaiting action |
| `bad` | rejected, below reorder, breach, variance flagged, difference |
| `info` | in progress, submitted, awaiting another party, in transit |
| `neutral` | closed, archived, reference chips |

**Per-screen states required** (§25): loading, empty, error, validation feedback,
success feedback, permission-aware actions. The prototype has none of these —
it renders synchronously from a JS object. All six are net-new per screen.

**Layout**: 240px sticky dark sidebar, grouped nav (Inventory / Procurement /
Receiving / Accounts — add **Dashboard**, **Masters**, **Vendors**), main column
`26px 32px 40px` padding, `gap:16px`. Mobile ≤ 900px: sidebar becomes an
off-canvas drawer with a top bar.

---

## 7. Integration points

| Integration | Direction | Notes |
|---|---|---|
| **Crystal Core SSO** | in | `/sso?token=` → verify at Core `/api/auth/verify` → mirror to `app_users` → signed HMAC cookie. Port v1.0 `lib/session.ts` + `/sso` verbatim; swap the user-sync target to `app_users (core_user_id, email, full_name)`. |
| **Tally** | both | `tally_po_ref` (PO issue gate), `tally_voucher_ref` (DN reconcile gate), `sites.tally_cost_centre` (site activation gate), `vendors.tally_ledger_ref` (vendor approval gate), `vendor_ledger_entries` side `TALLY` import. |
| **Bill Control** | out | `vendor_invoices.bill_control_ref`, `debit_note_offsets.bill_control_ref`. |
| **Email** | out | `email_config` + `notification_outbox` (transactional outbox — a failed send never rolls back the business transaction). Worker drains the queue. |
| **Document storage** | both | `documents` table: ≤ 10 MB, sha256, virus_scanned, `retention_class` default `STATUTORY_8Y`. v1.0 used Google Drive. |
| **Offline gate inward** | in | `captured_offline` flag; `arrived_at` stays server-authoritative on sync. |

---

## 8. What is mock in the prototype

Everything. The prototype has a single `const S = {…}` state object, hardcoded
arrays (`RCV`, `PR_LINES`, `quoteQty`), derived helpers that re-implement
financial maths in JS, and `localStorage` only for theme. There is no network
call, no persistence, no auth, and no permission logic anywhere in the file.

Specifically, these prototype behaviours must move server-side:

| Prototype does it in JS | Must become |
|---|---|
| `landed()`, `ranks()` | `v_quotation_landed_cost` (incl. `rank_no`) |
| `prGoods()`, `prTotal()` | `v_pr_totals` |
| `band(t)` value-band routing | `approval_bands` + `approval_band_levels` lookup |
| Document numbers as string literals | `next_document_no()` |
| `S.grnApproved` flips stock arrays | `post_stock_movement()` on GRN approval |
| `qcBalanced()` | `qc_lines_sum` CHECK (and mirrored client-side for UX) |
| `termsSum() !== 100` | `pr_payment_terms_total` CHECK |
| `tempBreach()` hardcoded −20/−15 | `item_classes.temp_min_c/temp_max_c` |
| "Three different user IDs — segregation satisfied" (static text) | SoD triggers |
| `toast()` success messages | real transaction results + audit rows |

---

## 9. Missing functionality (net-new, not in prototype)

**Master data CRUD** — sites, storage locations, item classes, items,
item-site settings, budget codes, approval bands + levels, user-site-roles,
QC checklists + points, email config, status transitions.

**Vendor lifecycle** — list, create, KYC validation (PAN/GSTIN/state),
duplicate detection, approval with Tally ledger ref, block/unblock, bank
account maker-checker, vendor categories, vendor sites.

**Workflow surfaces** — every list/queue/inbox screen: my MRs, pending
approvals, PR queue, RFQ tracker, PO register, expected deliveries, QC queue
with SLA countdown, GRN approval queue, shortfall register, damage register,
RTV register, invoice register, DN register, recon runs.

**Transfers** — the prototype references transfers on the MR screen but has no
transfer screen at all. Full request → approve → dispatch → receive UI is new.

**Stock issue** — `stock_issues` / `stock_issue_lines` have no prototype screen.

**Asset register** — `asset_units` appear only as a text string on the GRN
screen ("DL-DHU-0419 … "). Full serialised-asset register is new.

**Dashboard** — §24 specifies ~25 metrics across 6 groups. The prototype has no
dashboard screen. Entirely new, designed in the prototype's language.

**Audit trail viewer** — `audit_log` has no UI.

**Platform** — document upload/download with sha256 + virus scan, notification
outbox worker, error-mapping layer, idempotency keys on mutating endpoints.
