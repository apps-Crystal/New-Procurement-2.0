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

## Phase 6 — Inventory
Ledger, balances, asset units, issues, transfers, damage quarantine.

**Gate** — negative stock impossible; duplicate posting impossible; reversal
works; transfer round-trip leaves both sites correct and `IN_TRANSIT` drained;
`asset_units.bucket` matches balances.

---

## Phase 7 — Returns
Damage → decision → RTV → dispatch → acknowledgement → replacement receipt.

**Gate** — all three RTV sources work; approver ≠ raiser proven; QC-rejected
stock posts **no** reversal; warehouse-damage stock **does**; PRN and gate pass
minted on approval.

---

## Phase 8 — Accounts
Invoice → three-way match → debit note → credit note → offset → vendor ledger →
reconciliation.

**Gate** — duplicate invoice blocked; GST mode rule proven; DN single-source
proven; CN variance blocks closure without override; recon closes only at zero
difference.

---

## Phase 9 — Dashboard & reporting
All §24 metrics from real queries. Audit trail viewer. Operational reports.

**Gate** — every tile traceable to a named query; zero hardcoded numbers
(enforced by a test that greps the dashboard modules for numeric literals).

---

## Phase 10 — Hardening
Full test matrix (§33), permission tests per role × endpoint, transaction
rollback tests, constraint tests, workflow tests, accessibility pass, error-message
review, performance check on ledger and dashboard queries.

**Gate** — §36 acceptance walk-through completed end to end on a clean database
by three different users with correct roles, with no mock data.

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
