# Conflict Register — Prototype vs Schema

Per the brief (§37): where the prototype and the schema disagree, the conflict is
named, both behaviours stated, impact assessed, and a rule recommended. **No
conflict is silently resolved.**

Standing rule: **the schema wins on data and business constraints; the prototype
wins on UI and UX.** Conflicts C-01 and C-02 are the exceptions — they cannot be
resolved that way because the schema itself blocks a behaviour the brief
explicitly requires. Those two need your decision before Phase 2.

Legend: 🔴 blocks implementation · 🟠 needs a documented rule · 🟢 resolved by the standing rule

---

## 🔴 C-01 — Inter-site transfer cannot be modelled with the current movement types

**Prototype** — MR screen promises "Transfer 15 / Purchase 5", transfers go to the
holding site's Warehouse Lead. Stock ledger screen shows a `Transfer in` row.

**Schema** — `movement_type` offers exactly three transfer movements:
`TRANSFER_RESERVE`, `TRANSFER_OUT`, `TRANSFER_IN`. `post_stock_movement()` takes a
**single** `p_site_id`, and its idempotency key is
`source_type || ':' || source_id || ':' || p_movement`. `stock_balances` is keyed
`(site_id, item_id, bucket)`, and `IN_TRANSIT` is a real bucket surfaced by
`v_stock_position.in_transit`.

**The problem.** A transfer needs four balance effects:

1. source: `AVAILABLE → RESERVED` (on approval) — `TRANSFER_RESERVE` ✅
2. source: `RESERVED → IN_TRANSIT` (on dispatch) — `TRANSFER_OUT` ✅
3. source: `IN_TRANSIT → NULL` (on receipt, drains the source) — ❌ no movement type left
4. destination: `NULL → AVAILABLE` (on receipt) — `TRANSFER_IN` ✅

Step 3 and step 4 both fire on receipt against the same
`stock_transfer_lines.id`, so both would need `TRANSFER_IN`, producing the
identical idempotency key `TRANSFER_LINE:<id>:TRANSFER_IN`. The second call
silently returns the first row's id and **never posts**. Result: goods arrive at
the destination while the source site keeps the quantity in `IN_TRANSIT` forever.
Group stock is permanently overstated.

Routing `TRANSFER_OUT` straight to `NULL` avoids the collision but then
`IN_TRANSIT` is never populated and `v_stock_position.in_transit` is dead —
contradicting §16, which lists "In-transit stock" as a required dashboard metric,
and §24.

**Impact** — transfers are one of the three MR outcomes and a mandatory
acceptance-criteria path. Without a decision, either group stock is wrong or the
in-transit metric is permanently zero.

**Options**

| | Change | Consequence |
|---|---|---|
| **A (recommended)** | Add `site_id` to the idempotency key inside `post_stock_movement()`: `source_type:source_id:movement:site_id` | Smallest change; function body only, no table or enum changes. Existing single-site movements keep working unchanged (their key merely gains a stable suffix). Both legs of the receipt post correctly. |
| B | Add movement types `TRANSFER_IN_TRANSIT_OUT` / `TRANSFER_RECEIPT` to the `movement_type` enum | Clearer names, but alters the enum the brief calls authoritative, and `ADD VALUE` cannot run inside the schema's single transaction. |
| C | Post the source drain as `ADJUSTMENT` | No schema change, but pollutes the adjustment audit trail and makes transfer reconciliation unreadable. |

**Recommended rule** — Option A. One-line change to the key expression;
everything else in the schema stands.

---

## 🔴 C-02 — QC re-inspection is impossible

**Prototype / brief** — §13 requires `reinspection` as a supported QC outcome.

**Schema** — `qc_inspections.is_reinspection_of bigint REFERENCES qc_inspections(id)`
exists, but the same table declares
`gate_inward_id bigint NOT NULL UNIQUE REFERENCES gate_inwards(id)`.

**The problem.** A re-inspection is, by definition, a second `qc_inspections` row
against the same gate inward. The `UNIQUE` constraint rejects it. The
`is_reinspection_of` column can therefore never be non-null — it is unreachable
code.

**Impact** — the re-inspection path in §13 cannot be built at all. Conditional
holds that are re-inspected after vendor rework have nowhere to go.

**Options**

| | Change | Consequence |
|---|---|---|
| **A (recommended)** | Replace the column `UNIQUE` with a partial unique index: `CREATE UNIQUE INDEX qc_inspections_gi_original ON qc_inspections (gate_inward_id) WHERE is_reinspection_of IS NULL;` | One original inspection per gate inward, unlimited re-inspections chained off it. `grns.qc_id UNIQUE` still guarantees one GRN per inspection, so the GRN links to whichever inspection is final. |
| B | Model re-inspection as an in-place update of the original row | Destroys the original verdict — unacceptable under §29 auditability. |
| C | Drop re-inspection from scope | Contradicts §13. |

**Recommended rule** — Option A.

---

## 🟠 C-03 — Vehicle number format rejects the prototype's own example

**Prototype** — gate inward ships with `value="WB 11 C 4821"` (spaced).

**Schema** — `gi_vehicle_format CHECK (vehicle_no ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$')`
— no spaces permitted. The prototype's default value fails on insert.

**Rule** — store normalised (`upper`, strip spaces and hyphens) → `WB11C4821`.
Display formatted as `WB 11 C 4821`. Normalise in the service layer before
insert, and mirror the validation client-side so the user sees the error before
submitting. Applies equally to `seal_no`, `lr_no`, PAN, GSTIN, IFSC.

---

## 🟠 C-04 — Financial maths differs between prototype and views

**Prototype** — `landed()` computes `round(subtotal × 0.18)` — GST on the summed
subtotal at a flat 18%. `prGoods()` uses `round(qty × rate × 1.18)` per line.

**Schema** — `v_quotation_landed_cost` computes
`sum(round(qty × rate × (1 + gst_rate/100), 2)) + freight` — per-line rounding at
each line's own GST rate. `v_pr_totals` likewise, plus a separately-taxed
delivery charge.

**Impact** — the two disagree by rounding, and disagree materially whenever any
line is not 18% (items carry `default_gst_rate`, which is only *defaulted* to 18).

**Rule** — §10 is explicit: the database calculation is authoritative. The UI
renders `v_pr_totals` / `v_quotation_landed_cost` values and never recomputes
them. Client-side arithmetic is permitted only for live preview while typing, and
must be replaced by the server value on save. `rank_no` comes from the view, not
from a client sort.

---

## 🟠 C-05 — Budget code lives on the declaration, not the MR

**Prototype** — the MR header has a "Budget code" select, and the PR screen shows
budget code as "inherited from the MR".

**Schema** — `material_requests` has **no** `budget_code_id` column.
`mr_declarations.budget_code_id` is `NOT NULL`; `purchase_requests.budget_code_id`
is `NOT NULL`.

**Rule** — budget code is captured at the **declaration** step, not on the MR
header. The MR form keeps the field visually where the prototype puts it, but it
binds to the declaration and is only required when a declaration is required
(i.e. when there is a purchase balance). The PR inherits from
`mr_declarations.budget_code_id`. An MR fully met by transfer needs no budget code
at all — consistent with the prototype's own note that such MRs never reach a PR.

---

## 🟠 C-06 — MR "submit" conflates declaration, submission and approval

**Prototype** — `mrSubmit()` validates 40 characters + checkbox, then toasts
"MR submitted **and approved**" and jumps straight to the PR screen. One user,
one click, no approver.

**Schema** — `MR_DECLARED` and `MR_APPROVED` are distinct states, and
`mr_self_approval CHECK (approved_by <> requester_id)` makes self-approval
impossible.

**Rule** — split into three server actions: `declare` (requester, writes
`mr_declarations` + `mr_allocations`, state → `MR_DECLARED`), `approve` /
`reject` (a different user holding `CG_SMGR` at that site, state → `MR_APPROVED`
/ `MR_REJECTED`). The prototype's single button becomes "Submit declaration";
the approval UI is a net-new screen reachable from Pending Approvals. Keep the
prototype's step-strip so the requester can see where the MR is.

---

## 🟠 C-07 — Declaration allocation is decorative in the prototype

**Prototype** — hardcoded "Dhulagarh — Freezer block 70% / Chiller plant 30%" as
static text.

**Schema** — `mr_allocations` rows with a deferred constraint trigger enforcing
`sum(pct) = 100` per declaration.

**Rule** — build a real allocation editor (add/remove rows, site + cost head +
pct, live total with the prototype's `t-ok`/`t-bad` styling). The trigger is
`DEFERRABLE INITIALLY DEFERRED`, so all rows must be written inside one
transaction — a partial write would otherwise trip on the first row.

---

## 🟠 C-08 — Declaration has a 500-character ceiling the prototype ignores

**Prototype** — counts up from 40, no maximum.

**Schema** — `CHECK (char_length(business_impact) BETWEEN 40 AND 500)`.

**Rule** — show `40 ≤ n ≤ 500` in the counter; flag at both ends.

---

## 🟠 C-09 — Excess receipt has no defined outcome

**Prototype** — counted > per-challan shows "Excess N — held, not accepted".

**Schema** — `gate_inward_lines` stores `qty_per_challan` and `qty_counted` with
no excess column and no upper-bound constraint. `qty_short` only captures the
deficit. `v_po_line_receipt.qty_outstanding` can therefore go **negative** if
accepted quantity exceeds the order.

**Rule** — record the counted quantity as-is (never silently clamp, per §35).
Derive excess as `qty_counted - qty_per_challan`. QC receives `qty_delivered =
qty_counted`. If accepting would drive `v_po_line_receipt.qty_outstanding`
negative, the GRN cannot be approved — it must be `GRN_FLAGGED` with
`flag_reason` naming the over-receipt, and released only by `CG_SMGR` after a PO
amendment. Enforced in the GRN approval service.

---

## 🟠 C-10 — QC delivered quantity is not tied to the gate count by any constraint

**Prototype** — `qcDelivered(i)` reads the gate-inward counted quantity directly.

**Schema** — `qc_lines.qty_delivered` is a free `numeric`; only the internal sum
(`accepted + hold + rejected = qty_delivered`) is constrained. Nothing links it
to `gate_inward_lines.qty_counted`.

**Rule** — app-enforced invariant: the QC service sets `qty_delivered` from
`gate_inward_lines.qty_counted` and never accepts it from the client. Covered by
a test that attempts to post a mismatched value.

---

## 🟠 C-11 — Cold-chain tolerance and the breach consequence are hardcoded

**Prototype** — set point −18.0 °C and tolerance −20 to −15 °C are string
literals; the breach banner says "every line goes to conditional hold" but
nothing enforces it.

**Schema** — `item_classes.is_cold_chain`, `temp_min_c`, `temp_max_c`,
`requires_data_logger`; `gate_inwards.reefer_set_point_c`, `reefer_actual_c`,
`temp_in_tolerance`.

**Rule** — derive the band from the item classes of the lines on that gate
inward; where a gate inward mixes classes, apply the **tightest** band. Set
`temp_in_tolerance` server-side from `reefer_actual_c` against that band — never
from the client. When it is `false`, the QC service rejects any line with
`qty_accepted > 0` unless that line also carries a `qc_hold_decisions` row, and
`requires_data_logger` classes additionally require a `DATA_LOGGER` document
before the verdict can be submitted. Gate inwards with no cold-chain line leave
all three temperature fields null.

---

## 🟠 C-12 — Prototype role names are not schema roles

**Prototype** — "Head of Supply Chain" (non-lowest award), "Head of Operations"
(write-off band, 72h hold escalation), "Head of Finance" (short-credit
acceptance), "Storekeeper" (damage reporting, issues).

**Schema** — `role_code` has ten values and none of those four.

**Rule** — fix this mapping now and use it everywhere:

| Prototype label | `role_code` |
|---|---|
| Storekeeper | `CG_WHL` |
| Warehouse Lead | `CG_WHL` |
| Site Manager | `CG_SMGR` |
| Site Receiver | `CG_RCV` |
| QA/QC Inspector | `CG_QC` |
| Buyer | `CG_BUY` |
| Head of Supply Chain | `CG_FHEAD` |
| Head of Operations | `CG_FHEAD` |
| Head of Finance | `CG_FHEAD` |
| Director | `CG_DIR` |

Three distinct prototype personas collapse onto `CG_FHEAD`. That is acceptable
because they are separated by **site and band**, not by role — the approval that
routes to them is selected from `approval_band_levels`, which is seeded per
`entity_type`. If Crystal needs them genuinely distinct (e.g. Finance must not be
able to approve a supply-chain award), the `role_code` enum needs three more
values — flagged for your call, not assumed.

---

## 🟠 C-13 — Write-off above ₹50,000 needs an insurance reference the UI never asks for

**Prototype** — damage case values a coil write-off at ₹1,82,000 with no
insurance field anywhere on the screen.

**Schema** — `dmg_insurance_ref CHECK (decision <> 'WRITE_OFF' OR estimated_value
<= 50000 OR insurance_claim_ref IS NOT NULL)`.

**Rule** — the write-off decision card reveals a required "Insurance claim
reference" input as soon as `estimated_value > 50000`. Without it the action is
blocked client-side and rejected server-side.

---

## 🟠 C-14 — Credit-note variance does not actually block closure in the schema

**Prototype** — variance > 2% disables reconcile; an "Accept with approval" path
exists.

**Schema** — `compute_cn_variance()` sets `variance_flagged`, but **no constraint**
stops a `debit_notes` row reaching `DN_RECONCILED` while flagged.
`vendor_credit_notes.accepted_short_by` is the intended override but is never
checked.

**Rule** — app-enforced: a debit note may not transition to `DN_RECONCILED` while
its most recent credit note has `variance_flagged = true` and
`accepted_short_by IS NULL`. Setting `accepted_short_by` requires `CG_FHEAD` and
writes an `audit_log` row with `action = 'OVERRIDE'`. Covered by tests.

---

## 🟠 C-15 — Stock ledger entry numbers: two different formats

**Prototype** — `SL-DHU-104881` (flat serial).

**Schema** — the comment on `stock_ledger.entry_no` says `SL-DHU-104881`, but the
function it actually calls, `next_document_no('SL', site_code)`, returns
`SL-DHU-Sep2026/0001`.

**Rule** — the function wins; entry numbers are period-scoped. The prototype's
display format is cosmetic. UI uses the real value.

---

## 🟠 C-16 — PR self-approval is not blocked by the schema

**Prototype** — states "You cannot approve your own PR. Checked by user ID." on
two screens.

**Schema** — `material_requests` has `mr_self_approval`; `purchase_returns` has
`rtv_self_approval`; **`purchase_requests` has no equivalent CHECK**, and the
generic `approvals` table has no guard against `approver_id = requester_id`.

**Rule** — app-enforced in the approval engine: an approval may not be decided by
the entity's originator, for every entity type, regardless of whether a CHECK
exists. Implemented once in the shared engine so PR, write-off, award, waiver,
vendor, bank, RTV and GRN all inherit it. Explicit test per entity type.

---

## 🟠 C-17 — One PO per PR is a hard constraint with business consequences

**Schema** — `purchase_orders.pr_id NOT NULL UNIQUE` and
`quote_awards.pr_id UNIQUE`.

**Consequence** — a PR can never be split across two vendors, and a cancelled PO
cannot be replaced without cancelling the PR. The prototype's PO check-list
("First PO against this PR ✓") agrees, so this is intentional — recorded here so
it is not discovered later as a bug.

**Rule** — surface it in the UI: once a PO exists, the award screen is read-only
and shows the PO link. Splitting a requirement across vendors requires splitting
the MR into two PRs, which the MR→PR step must therefore support. A cancelled PO
requires a new PR raised from the same MR balance.

---

## 🟠 C-18 — Balances are site-level; the prototype implies location-level

**Prototype** — damage case shows "Location · Rack C-04"; GRN has a location
column.

**Schema** — `stock_balances` PK is `(site_id, item_id, bucket)` — no location.
`stock_ledger.location_id` and `asset_units.location_id` exist as attributes of
movements and units.

**Rule** — location is **informational on movements and serialised units only**.
There is no per-location balance and none will be synthesised. Location filters
on stock screens operate over ledger entries and asset units, not balances. Stated
plainly in the UI so warehouse staff do not read a location total as authoritative.

---

## 🟠 C-19 — `asset_units.bucket` can drift from `stock_balances`

**Schema** — serialised items carry a per-unit `bucket` on `asset_units` **and**
contribute to the aggregate `stock_balances` row. No trigger keeps them in step.

**Rule** — app-enforced invariant: any movement touching a serialised item
updates the matching `asset_units.bucket` inside the same transaction as
`post_stock_movement()`. A nightly consistency check reports drift
(count of `asset_units` per bucket vs `stock_balances.qty`) rather than
silently repairing it.

---

## 🟠 C-20 — `post_stock_movement()` raises database-language errors

**Schema** — overdraw surfaces either as
`No % stock for item % at site %` or as a bare `23514` check violation on
`stock_balances.qty >= 0`.

**Rule** — §32 requires business-readable errors. `lib/errors.ts` maps constraint
names and SQLSTATEs to messages, e.g. `stock_balances_qty_check` →
"Dhulagarh does not have enough available stock of HDPE pallet 1200 × 1000 to
issue 40 Nos — 12 Nos available." Technical detail is logged, never shown.

---

## 🟢 C-21 — `v_stock_position` is a full cross join

`sites CROSS JOIN items` materialises every site × item pair regardless of whether
stock exists. At Crystal's stated 12 sites this is fine for a site-filtered
screen but will not serve a group-wide dashboard tile.

**Rule** — always query it with a `site_id` predicate. Dashboard aggregates read
`stock_balances` directly. Revisit with a materialised view only if measurement
shows it is needed — not pre-emptively.

---

## 🟢 C-22 — The prototype does not demonstrate one continuous chain

The procurement flow runs on **PO-…/0019** (Arctic Cool — evaporator, compressor,
refrigerant); the receiving flow runs on **PO-…/0014** (Northern Polymers — HDPE
pallets, PUF panels, data loggers, gel ice packs). They never meet.

**Impact** — §36 requires one user to walk MR → … → Reconciliation unbroken.

**Rule** — the seed script builds one continuous chain on a single PO, plus the
side cases (damage, warranty, shortfall) the prototype illustrates. Seed data is
clearly marked and lives in a separate, optional migration so production never
loads it.

---

## 🟢 C-23 — Empty tables the schema requires to be populated

`status_transitions`, `approval_bands`, `approval_band_levels`, `email_config`,
`qc_checklists`, `qc_checklist_points` ship empty but are load-bearing:
`notification_outbox.event_key` has an FK to `email_config`; `qc_lines.checklist_id`
is `NOT NULL`; and the schema states the API rejects any transition not listed in
`status_transitions`.

**Rule** — these are **reference data, not demo data**. They ship in a required
migration (`0002_reference_data.sql`), separate from the optional seed of C-22.

---

## 🟠 C-24 — `site_code_immutable()` checks too few tables

**Schema** —

```sql
IF NEW.code <> OLD.code AND EXISTS (
     SELECT 1 FROM material_requests WHERE site_id = OLD.id
     UNION ALL SELECT 1 FROM purchase_orders WHERE site_id = OLD.id LIMIT 1) THEN
  RAISE EXCEPTION 'Site code % cannot change once transactions exist', OLD.code;
```

The message says *"once transactions exist"*, but only two tables are consulted.

**The problem.** A site can hold stock movements, gate inwards, GRNs, transfers,
damage reports, issues or purchase returns without ever having a material
request or a purchase order against it — an opening-balance load alone does it.
The trigger would let such a site be renamed.

That is not cosmetic. `next_document_no()` embeds the site code in every number
it issues: `SL-DHU-Sep2026/0001`, `GRN-DHU-Sep2026/0022`. Renaming `DHU` to
`DHUL` leaves every previously-issued document under a code that no longer
exists anywhere, with nothing linking old to new. On Sheets this is worse still,
because those numbers are the identity a human reads in the workbook.

**Found by** `npm run verify:live`, which expected a site carrying stock ledger
entries to refuse a code change and found that it did not.

**Rule** — the check covers every table that records an event at a site:
`material_requests`, `purchase_orders`, `stock_ledger`, `gate_inwards`, `grns`,
`damage_reports`, `stock_issues`, `purchase_returns`, and `stock_transfers` on
either leg. Implemented in `lib/services/masters.ts`; one batched read, and site
edits are rare enough for the cost not to matter.

This is a deliberate widening of a supplied constraint rather than a
reinterpretation of it — the trigger's stated intent is kept, its incomplete
implementation is not.

---

## 🔴 C-26 — QC re-inspection is still impossible, one level down

**Found by** building the re-inspection path in Phase 5. Amendment C-02 was
necessary but not sufficient.

**Schema** — `qc_lines`:

```sql
gate_inward_line_id bigint NOT NULL UNIQUE REFERENCES gate_inward_lines(id),
```

**The problem.** C-02 fixed the parent: `qc_inspections` no longer carries
`UNIQUE (gate_inward_id)`, so a gate inward can hold one original inspection
plus a chain of re-inspections. But `qc_lines` carries the identical defect
against the identical idea. A re-inspection needs its own `qc_lines` rows
covering the same gate-inward lines as the inspection it follows — that is what
re-inspecting *is*. The global `UNIQUE` forbids the second set.

So after C-02 the parent row inserted successfully and the child insert failed.
Re-inspection remained impossible; only the error message moved.

The trap is that the constraint expresses a real rule — a gate-inward line
should not be inspected twice *on one inspection* — but scopes it to all of
history rather than to the inspection. Across inspections, inspecting again is
the entire point.

**Why not work around it in the service.** The only way through without a schema
change is to detach or overwrite the original inspection's lines. `NOT NULL`
blocks detaching, and overwriting destroys the original verdict — which is the
very thing C-02 chose option A to preserve, and which §29 requires. A workaround
here would quietly undo C-02.

**Rule** — the constraint becomes composite, in `0004_qc_lines_reinspection.sql`:

```sql
ALTER TABLE qc_lines DROP CONSTRAINT qc_lines_gate_inward_line_id_key;
ALTER TABLE qc_lines
  ADD CONSTRAINT qc_lines_inspection_line_uq UNIQUE (qc_id, gate_inward_line_id);
```

Nothing that mattered is loosened. A duplicate line within one inspection is
still refused, and `grns.qc_id UNIQUE` still guarantees one GRN per inspection,
so the GRN attaches to whichever inspection is final.

`shortfall_cases.gate_inward_line_id NOT NULL UNIQUE` is left alone: a shortfall
is a gate fact, settled once, and is genuinely one per line however many times
quality is re-judged.

---

## 🔴 C-27 — `ADJUSTMENT` is a movement type with nothing to move it

**Found by** building the stock-take path in Phase 6.

**Schema** — `movement_type` includes `'ADJUSTMENT'`, and every ledger entry
must name its source:

```sql
source_type text   NOT NULL,   -- GRN_LINE, TRANSFER_LINE, DAMAGE_REPORT, …
source_id   bigint NOT NULL,
idempotency_key text NOT NULL UNIQUE,  -- source_type:source_id:movement:site_id
```

Every other `source_type` in that list is a row in a table, and
`stock_ledger_source_idx ON (source_type, source_id)` exists so that "what
caused this movement" can be answered. `ADJUSTMENT` has no such table.

**The problem, in two parts.**

The visible one: `source_id` would point at nothing. The source index stops
answering its question for exactly the movements that most need explaining —
the ones where the system was simply wrong.

The one that bites: **the idempotency key would not be unique.** Any scheme
built from what an adjustment actually has — site and item — makes a second
stock-take of the same item at the same site collide with the first. And
`post_stock_movement()` treats a key collision as a replay: it returns the
original entry and posts nothing. The second count would silently do nothing at
all, report success, and leave the balance untouched.

That is the worst possible failure for a stock take, because the screen would
show the count accepted. It was caught by asserting that two consecutive counts
of the same item produce two different ledger entries.

**Why not a sequence.** A synthetic id makes the key unique and leaves the
source dangling — it fixes the failure while keeping the defect. A stock take is
also a business record in its own right: who counted, when, what the system
said, what they found, and why. The audit log records *that* it happened; it is
not where a warehouse looks it up.

**Rule** — `ADJUSTMENT` gets the table the schema's own design implies, in
`0005_stock_adjustments.sql`. Append-only like the ledger it explains, with
`delta` generated from the two quantities so the movement can never disagree
with the count behind it, and a `CHECK` that a matching count is not recorded at
all. There is deliberately no `stock_entry_id` column: the ledger already points
here through the source index, and a second copy of that fact could only go
stale.

Nothing in the supplied schema is changed. A missing piece is added.
