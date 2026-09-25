# Implementation Plan

Ten phases, each ending in a runnable, tested state. No phase starts before the
previous one passes its gate.

**Proposed stack** — Next.js 16 (App Router) + React 19 + TypeScript,
`postgres.js`, Tailwind 4 with the prototype's tokens as CSS variables, Jest +
Testcontainers (real PostgreSQL 15, never a mock) for service and constraint
tests, Playwright for workflow tests. This mirrors Crystal Procurement v1.0 so
the SSO, session and database modules port across rather than being rewritten.

---

## Phase 1 — Analysis ✅ complete
`docs/01-architecture-map.md`, `docs/02-conflict-register.md`,
`docs/03-screen-api-map.md`, this file. No code written.

**Gate** — conflicts C-01 and C-02 decided.

---

## Phase 2 — Foundation ✅ complete
- Scaffold Next.js + TypeScript + Tailwind 4; port the prototype's token block
  verbatim into `app/globals.css`.
- `lib/db.ts` — port from v1.0 (lazy proxy client, `withDbRetry`, pooler-safe).
- `lib/session.ts`, `app/sso/route.ts` — port from v1.0; retarget user sync to
  `app_users (core_user_id, email, full_name)`.
- `lib/auth/permissions.ts` — role + site resolution from `user_site_roles`,
  fail-closed, short-lived cache.
- `lib/errors.ts` — constraint/SQLSTATE → business message map (C-20).
- `lib/audit.ts` — one writer for `audit_log`, called inside every mutating tx.
- `lib/transitions.ts` — guard reading `status_transitions`.
- `lib/documents.ts` — upload with sha256, size and MIME checks.
- `lib/notify.ts` — outbox writer + drain worker.
- Migrations: `0001_schema.sql` (supplied schema verbatim + the C-01/C-02
  amendments as a clearly-commented addendum), `0002_reference_data.sql`
  (`status_transitions`, `approval_bands`, `approval_band_levels`,
  `email_config`, `qc_checklists`).
- Shared UI: `AppShell`, `Sidebar`, `Card`, `DataTable`, `StatusChip`, `Kpi`,
  `Field`, `Steps`, `Bars`, `Kanban`, `Toast`, `EmptyState`, `ErrorState`,
  `LoadingState`, `PermissionGate`.

**Gate** — app boots, SSO round-trip works against Core, migrations apply clean
on an empty PostgreSQL 15, `audit_log` and `stock_ledger` reject UPDATE/DELETE.

---

## Phase 3 — Master data ✅ complete
Sites, storage locations, item classes, items, item-site settings, budget codes,
approval bands + levels, user-site-roles, QC checklists, vendors + bank
maker-checker + categories + sites.

**Gate** — every master CRUD screen has all six states; PAN/GSTIN/duplicate
tests pass; bank maker-checker proven; `vba_one_live` proven.

---

## Phase 4 — Procurement ✅ complete
MR → stock check → transfer → declaration → PR → approval → quotations →
comparison → award → PO.

**Gate** — the three MR outcomes (full / partial / none) all work; PR quantity
lock proven; payment-terms rule proven; edit lock after approval proven;
non-lowest award and waiver proven; PO blocked for unapproved vendor and
without Tally ref.

**Gate met.** `npm run verify:procurement` walks the whole chain against a
throwaway PostgreSQL with five distinct people, so segregation of duties is
exercised rather than asserted: 42 checks, all passing. The interesting ones are
the refusals — self-approval on an MR, a PR and a transfer; an out-of-order
approval; an edit after approval; a second PO on one PR; a blocked vendor on an
order; an expired quotation awarded; a non-lowest award with no justification.

Delivered:

| | |
|---|---|
| Services | `mr`, `transfers`, `pr`, `quotations`, `po`, `approvals` |
| API | 24 routes under `/api/mr`, `/api/transfers`, `/api/pr`, `/api/quotations`, `/api/po`, `/api/approvals` |
| Screens | `/mr`, `/mr/[id]`, `/transfers`, `/transfers/[id]`, `/pr`, `/pr/[id]`, `/po`, `/po/[id]`, `/quotations`, `/approvals` |

Two things surfaced during the phase and are recorded rather than patched over:

- **D-07** — a Functional Head could not approve a vendor, because vendors are
  group-wide but the permission was checked at site `0`. `TransitionRequest.siteId`
  is now `number | null`, and `null` means "held anywhere".
- **`v_pr_totals.taxable` is unrounded.** The view sums `qty(14,3) × rate(14,2)`
  without rounding, so it arrives at scale 5 while `gst` and `total_incl_gst` are
  rounded per line. The value is exact; the UI formats it to paise.

---

## Phase 5 — Receiving ✅ complete
Gate inward → QC → GRN → shortfall.

**Gate** — duplicate challan blocked; vehicle normalisation works; temperature
rule enforced; QC sum rule and reason rule proven; all three SoD triggers proven;
GRN approval posts stock through `post_stock_movement()` and is replay-safe.

**Gate met.** `npm run verify:procurement` now walks the whole §36 chain, from
material request to posted stock, with seven distinct people: 70 checks, all
passing. Every clause above has its own check, including a separate cold-chain
consignment built end to end so the temperature rule is proven on real item
classes rather than asserted.

Delivered:

| | |
|---|---|
| Services | `gate-inward`, `qc`, `grn`, `shortfall` |
| API | 13 routes under `/api/gate-inward`, `/api/qc`, `/api/grn`, `/api/shortfalls` |
| Screens | `/gate-inward`, `/gate-inward/[id]`, `/qc`, `/qc/[id]`, `/grn`, `/grn/[id]`, `/shortfalls` |
| Migration | `0004_qc_lines_reinspection.sql` (conflict C-26) |

Three things surfaced during the phase:

- **C-26 — re-inspection was still impossible.** Amendment C-02 fixed
  `qc_inspections` but left `qc_lines.gate_inward_line_id NOT NULL UNIQUE`, which
  blocks the child rows a re-inspection needs. The constraint is now composite,
  `(qc_id, gate_inward_line_id)`. Without it, the only route through would have
  destroyed the original verdict — undoing C-02 in all but name.

- **A sentinel for uninspected lines.** `qc_lines_sum` must balance from the
  first insert, so a new line parks the whole counted quantity in `qty_hold`.
  That is not the same thing as stock somebody held back, and without the
  distinction every fresh inspection floods the Site Manager's hold queue.

- **Document upload is still outstanding** (a Phase 2 item). The C-11
  data-logger gate is implemented and will correctly refuse a
  `requires_data_logger` class until the file is attached — but nothing can
  attach one yet, so that path is unreachable in the product. No item class in
  use sets the flag, so nothing is currently blocked.

---

## Phase 6 — Inventory ✅ complete
Ledger, balances, asset units, issues, transfers, damage quarantine.

**Gate** — negative stock impossible; duplicate posting impossible; reversal
works; transfer round-trip leaves both sites correct and `IN_TRANSIT` drained;
`asset_units.bucket` matches balances.

**Gate met.** `npm run verify:procurement` runs 95 checks across the whole
chain. Every clause has its own check: an over-issue is refused naming what is
actually there, a second approval cannot double-post, a reversal mirrors and
both entries survive, and `assetDrift()` returns empty after a receipt and again
after an issue.

Delivered:

| | |
|---|---|
| Services | `inventory`, `issues`, `assets`, `damage` |
| API | 15 routes under `/api/inventory`, `/api/issues`, `/api/assets`, `/api/damage` |
| Screens | `/inventory`, `/inventory/ledger`, `/inventory/issues`, `/inventory/issues/[id]`, `/inventory/assets`, `/damage`, `/damage/[id]` |
| Migration | `0005_stock_adjustments.sql` (conflict C-27) |

Three things worth recording:

- **C-27 — `ADJUSTMENT` had no source table.** Not merely untidy: the
  idempotency key is built from the source, so a second stock-take of the same
  item would have collided with the first and silently posted nothing while
  reporting success. Caught by asserting two consecutive counts produce two
  entries.

- **C-19 moved inside `post_stock_movement`.** The register's rule was that
  every caller updates `asset_units.bucket` alongside its movement. Doing it in
  the one function that moves stock is the same transaction and the same
  guarantee, minus the chance of a caller forgetting.

- **Asset units are minted on GRN approval.** `items.is_serialised` existed and
  nothing had ever created an `asset_units` row, so the asset register was
  unreachable. Receipts now mint one unit per received unit, tagged
  `<ITEM>-<SITE>-0001`, with warranty running from receipt.

One limitation, stated rather than hidden: `assetDrift()` excludes
`WRITTEN_OFF`. `stock_bucket` has no value meaning "issued out", so a serialised
unit leaving on an issue has nowhere to go but `WRITTEN_OFF` — while the ISSUE
movement takes its quantity out of the site entirely rather than into a
`WRITTEN_OFF` balance. The two populations in that bucket are not comparable.
Every bucket where the two genuinely must agree is still checked.

---

## Phase 7 — Returns ✅ complete
Damage → decision → RTV → dispatch → acknowledgement → replacement receipt.

**Gate** — all three RTV sources work; approver ≠ raiser proven; QC-rejected
stock posts **no** reversal; warehouse-damage stock **does**; PRN and gate pass
minted on approval.

**Gate met.** `npm run verify:procurement` runs 110 checks. Each clause has its
own: the three sources are exercised separately and the two that post nothing
are asserted against the ledger row count, not merely against a balance.

Delivered:

| | |
|---|---|
| Services | `rtv`, plus the decision chain completing `damage` |
| API | 7 routes under `/api/rtv` and `/api/damage/[id]` |
| Screens | `/returns`, `/returns/[id]`, and the decision card on `/damage/[id]` |

The design point worth recording is the one the gate is built around: **which
origin a return has decides whether stock moves at all.**

- **QC rejection** — failed inspection, never received. Physically in the
  receiving bay, but no GRN line covers it and no ledger entry exists.
  Approving posts nothing.
- **Warehouse damage** — received, entered stock, later found damaged. Sitting
  in `DAMAGED_HOLD` because the damage report quarantined it. Approving posts
  `RTV_REVERSAL` and drains that hold.
- **Shortfall** — never arrived. Nothing in the building, nothing in the ledger.

The schema states half of this, in a comment on
`purchase_return_lines.reversal_entry_id`: *"QC rejections never entered stock,
so there is nothing to reverse."* Getting it wrong in either direction quietly
doubles or destroys inventory, so the screens say which case they are in before
anything is approved rather than leaving the three looking identical.

Two further notes:

- **A write-off is always banded**, however small. `WRITE_OFF` bands start at
  ₹0 and level 1 is `CG_WHL`, so even a ₹4,300 write-off needs an approver who
  is not the reporter. Stock is destroyed only when the last level clears; a
  refusal returns the report to the inspectors with the stock still
  quarantined.

- **A warranty claim is judged on the observation date**, not today.
  `damage_reports.in_warranty` is generated from `warranty_until` and
  `observed_on`, so sitting on a report until the warranty lapses does not
  change whether the claim was valid — and `dmg_warranty_claim` refuses the
  decision outright once it was not.

---

## Phase 8 — Accounts ✅ complete
Invoice → three-way match → debit note → credit note → offset → vendor ledger →
reconciliation.

**Gate** — duplicate invoice blocked; GST mode rule proven; DN single-source
proven; CN variance blocks closure without override; recon closes only at zero
difference.

**Gate met.** `npm run verify:procurement` runs 131 checks across the whole
chain, from material request to a vendor reconciliation confirmed by the vendor.
Every clause above has its own check.

Delivered:

| | |
|---|---|
| Services | `invoices`, `debit-notes`, `reconciliation`, `ledger-accounts` |
| API | 13 routes under `/api/invoices`, `/api/debit-notes`, `/api/reconciliation` |
| Screens | `/invoices`, `/invoices/[id]`, `/notes`, `/notes/[id]`, `/reconciliation`, `/reconciliation/[id]` |

Three things worth recording:

- **C-14 settled.** `compute_cn_variance()` flags a credit note more than 2%
  short of what was debited, and the schema then does nothing with the flag.
  Reconciliation is now blocked while a flagged note is unaccepted;
  `accepted_short_by` is the schema's own intended override and setting it
  requires CG_FHEAD and is audited as an OVERRIDE.

- **C-28 raised.** `vi_tax_mode` stops an invoice carrying both GST modes but
  has no opinion on which applies. The mode is now derived from the place of
  supply against the receiving site's state, and a mismatch is refused — the
  comparison is two joins from the invoice, so no constraint could express it.

- **The two ledger sides are never reconciled by adjustment.** PORTAL rows are
  written by the app; TALLY rows are imported exactly as supplied. An import
  that rounded or netted anything on the way in would hide the discrepancy the
  reconciliation exists to surface — and `recon_zero_to_close` means a run
  cannot be closed while they differ, with no override.

One bug found by the verification and worth naming, because it was invisible:
`runReconciliation` read its own findings back through the global client rather
than the transaction, so it returned the *previous* run's items while the run
row itself was correct. Caught only by asserting on the item list, not on the
balance.

---

## Phase 9 — Dashboard & reporting ✅ complete
All §24 metrics from real queries. Audit trail viewer. Operational reports.

**Gate** — every tile traceable to a named query; zero hardcoded numbers
(enforced by a test that greps the dashboard modules for numeric literals).

**Gate met.** 36 metrics across 6 groups, each carrying the name of the query
that produced it — shown in small print on the tile itself, so a figure can be
traced without reading the code. The grep test exists and was **proven to fail**
by planting a typed tile value and a literal ₹ figure; both were caught.

Delivered:

| | |
|---|---|
| Services | `dashboard` (6 grouped queries), `audit-trail` |
| API | 4 routes under `/api/dashboard` and `/api/audit` |
| Screens | `/` (dashboard), `/audit` |
| Tests | 5 new architecture tests; 139 checks in the chain |

Design points:

- **One query per group, not one per tile.** Twenty-four round trips to draw a
  home page is a home page nobody keeps open, and each group's metrics come off
  the same few tables anyway.

- **Every tile is a link.** A tile you cannot act on is a decoration, and a
  tile linking somewhere you cannot open is a bug found by clicking — so every
  query is site-scoped, checked by a test that reads each group's body for
  `scope(principal)`.

- **Group-wide figures read `stock_balances`, never `v_stock_position`.** That
  view cross-joins sites to items (conflict C-21) and is only ever read one
  site at a time.

### An audit gap this phase found

Asserting that a purchase request's history contains `PO_POSTED` failed. Five
services moved **another entity's** status as a side effect and audited only the
entity they were called about:

| Service | Moved | Was audited as |
|---|---|---|
| `po.issuePo` | PR → `PO_POSTED` | PO only |
| `grn.advancePoStatus` | PO → `PO_PARTIALLY_RECEIVED` / `PO_RECEIVED` | GRN only |
| `transfers.requestTransfer` | MR → `MR_TRANSFER_REQUESTED` | TRANSFER only |
| `transfers.decideTransfer` | MR → `MR_TRANSFER_APPROVED` / `REJECTED` | TRANSFER only |
| `transfers.receiveTransferOrder` | MR → `MR_FULFILLED_INTERNAL` | TRANSFER only |

The moved record's history simply stopped, with nothing saying who moved it or
why. §29 asks that a record's own history explain how it got where it is, so
each now writes a paired audit row against the entity whose status changed.

This is the kind of gap a walkthrough never finds — every screen looked right,
and the trail was only wrong when read from the other end.

---

## Phase 10 — Hardening ✅ complete
Full test matrix (§33), permission tests per role × endpoint, transaction
rollback tests, constraint tests, workflow tests, accessibility pass, error-message
review, performance check on ledger and dashboard queries.

**Gate** — §36 acceptance walk-through completed end to end on a clean database
by three different users with correct roles, with no mock data.

**Gate met, and exceeded.** `npm run verify:procurement` walks the whole chain
on a database created and dropped per run, with **ten distinct users** holding
real roles. No mock data exists anywhere in the run: every record is created
through the services, by someone entitled to create it.

One command runs everything:

```
npm run verify:all
```

| Suite | What it proves |
|---|---|
| `typecheck` | clean |
| `test` | 79 unit, architecture, accessibility and error-message tests |
| `verify:db` | 32 schema checks — constraints, triggers, generated columns |
| `verify:permissions` | **400 role × action pairs** against the real services |
| `verify:procurement` | **147 checks**, material request → vendor reconciliation |

### The permission matrix

`verify:permissions` is deliberately not "call `can()` and compare to the
matrix", which would only prove the matrix equals itself. Forty probes call the
real service with a principal holding exactly one role:

- a denied role must **never succeed** — unconditional;
- where a permitted role then succeeds, proving the action was possible, every
  denied role must have been stopped by **authorisation specifically**, not by
  state or by chance.

Denied roles run first, so the state they all see is identical.

Building it needed three fixture users, because the segregation rules are real
and the fixtures are not exempt: the person who creates a vendor cannot approve
it, and a goods receipt needs a receiver, an inspector and an approver who are
three different people.

### What it found

Two genuine defects, both recorded in the conflict register:

- **C-29 — a status oracle.** `assertTransition` checked the arrow before the
  permission, so an unauthorised caller learned a record's exact status from
  the refusal message. 124 of 400 pairs. Fixed by asking whether the caller
  works with that entity type at all before explaining anything.

- **C-30 — seven state refusals thrown as `forbidden`.** "The stock check
  cannot be re-run" applies to everyone; calling it forbidden tells a Site
  Manager they lack a permission they hold, and answers 403 where 409 is true.

And three of my own test bugs worth naming, because the guard caught them:
probes naming permission keys that do not exist (`MASTER.CREATE`,
`QUOTATION.CREATE`, `QUOTATION.AWARD`). `can()` fails closed on an unknown key,
which is right — but a probe using one would silently prove nothing, so the
script now refuses to start if a probe names a key the matrix does not hold.

### Accessibility and error messages

Static checks in `__tests__/hardening.test.ts`, each **proven to fail** by
planting the mistake it exists to catch:

- every form control has a label, including per-row ids built in a loop;
- clickable non-buttons carry `role`, `tabIndex` and `onKeyDown`;
- icon-only buttons carry an `aria-label`;
- no thrown message leaks a SQLSTATE, a constraint violation or a `pg_` name;
- every mapped constraint has a sentence rather than its own name.

JSX cannot be matched with a naive regex — `onClick={() => x}` contains `>`, so
`[^>]*` stops mid-tag. The tests use a small scanner that tracks brace depth
and strings, which is the difference between a test that works and one that
reports the first handler it meets.

### Rollback, constraints and performance

- a failure part way through an issue leaves no header, no ledger row and no
  audit row — **and rolls the document-number counter back with it**;
- `stock_ledger` and `audit_log` refuse UPDATE and DELETE, tested against the
  trigger directly rather than through a service;
- `stock_balances.qty >= 0` holds against a direct UPDATE that bypasses every
  service;
- the dashboard answers in under 3s, the ledger in under 2s, and
  `v_stock_position` is shown to narrow by site rather than materialising every
  site × item pair (conflict C-21).

### The three Phase 2 leftovers, now closed

All three were outstanding when Phase 10 first finished. They are done.

**Document upload.** `lib/services/documents.ts` stores files on disk under a
directory the deployment chooses, named by their own SHA-256 so the same file
uploaded twice is one file and two records. An allow-list of types, a 10 MB
ceiling checked twice — once against the declared length before the body is
read, once against the bytes actually received — and the extension must agree
with the declared MIME type, because a `.pdf` announced as an image is either a
mistake or an attempt.

The hash is re-checked on the way out. A file changed on disk by something
outside the application is refused rather than served as the original, which is
proved by a check that edits a stored file and asserts the download fails.

Downloads carry `Content-Disposition: attachment` and `X-Content-Type-Options:
nosniff`. An HTML or SVG file served inline would run in the application's own
origin — which is how an uploaded document becomes a stored cross-site script.

On virus scanning: there is no scanner on a localhost box, and defaulting
`virus_scanned` to true would be worse than leaving it false. It stays false,
and `SCAN_MODE=require` refuses to serve an unscanned file where a deployment
has one.

**This closes C-11.** The data-logger gate has existed since Phase 5 with no
way to satisfy it. A check now flips `FRZ` to `requires_data_logger`, proves
the inspection cannot be completed, attaches the logger, and proves the same
call then succeeds.

**Notification outbox.** `lib/notify.ts` writes to `notification_outbox` inside
the caller's transaction, which is what the schema's own comment asks for:
*"a failed send never blocks the transaction"*. Eight events are wired at the
moment the thing happens. Sending is a separate process
(`npm run drain:outbox`, `--watch` to keep going), because a user waiting on an
SMTP handshake is waiting on somebody else's infrastructure.

Retry, backoff and dead-lettering are real and tested: a failing transport
retries five times with a minute of backoff per attempt, then marks the message
DEAD and stops. `enqueue` never throws for a business reason — an unknown event
key is logged and swallowed, because the foreign key to `email_config` would
otherwise abort a goods receipt over an email.

`MAIL_TRANSPORT` chooses the transport: `log` (default) prints what would have
been sent, `noop` drops it, `fail` always fails so the retry machinery can be
proved. A real SMTP transport is a small addition at one marked point.

**Load testing.** `npm run verify:performance` builds a database the size
Crystal will run — 12 sites, 2,000 items, 60,000 ledger entries, 40,000 audit
rows, 2,000 orders with their full MR → PR → PO line chain — and times the
queries a screen waits on, each against a budget. Seeding is raw SQL via
`generate_series`: 60,000 entries through `post_stock_movement()` would take an
hour and would not answer the question, which is how the READS behave when the
tables are large.

Measured on the development machine:

| Query | Time | Budget |
|---|---|---|
| dashboard, group-wide (6 queries) | 184ms | 2500ms |
| dashboard, one site | 31ms | 2500ms |
| stock position, one site (800 rows) | 25ms | 1200ms |
| stock ledger, newest 200 | 51ms | 800ms |
| audit trail, newest 200 | 14ms | 800ms |
| audit summary | 23ms | 1500ms |
| expected deliveries (1500 rows) | 170ms | 1500ms |

The actual figure is printed whether or not it passes, because a query that has
quietly gone from 40ms to 900ms is worth seeing well before it reaches its
budget.

### Still not done

- **A real mail transport.** The outbox, its retry and its dead-lettering are
  built and tested; what is missing is SMTP or a provider, which is one
  function at a marked point in `lib/notify.ts`.
- **A virus scanner.** Same shape: the flag, the gate and the refusal are
  built; no scanner runs.
- **Crystal Core SSO and deployment**, both excluded by instruction.

---

## Test strategy

Service and constraint tests run against **real PostgreSQL 15** via
Testcontainers. Constraint behaviour is the product here; a mocked database would
test nothing that matters.

Every test in §33 is written as a named case against a live schema. The
highest-value ones — the invariants that must never regress:

- posting the same GRN line twice yields one ledger row and one balance change
- issuing more than available raises, and leaves the balance untouched
- a transfer round-trip nets to zero across both sites
- each SoD rule rejects the same user in all three receiving roles
- a failed step inside GRN approval rolls back the whole transaction, leaving no
  partial ledger rows and no orphan document number
- an approved PR cannot be edited through any endpoint
- every state transition not present in `status_transitions` is refused
