# Binding Decisions

Recorded 2026-09-23. These settle the open items from Phase 1 and are binding on
all later phases. Changing one means revisiting the phases that depend on it.

---

## D-01 — Stack: match Crystal Procurement v1.0

Next.js 16 (App Router) + React 19 + TypeScript, `postgres.js`, Tailwind 4
carrying the prototype's design tokens, Jest + Testcontainers against real
PostgreSQL 15, Playwright for workflow tests.

**Why** — v1.0 is the direct predecessor of this system (the schema references it
throughout). Its Crystal Core SSO route, signed-session module and pooler-safe
database client are production-proven and port across rather than being rewritten.

**Consequence** — `lib/db.ts`, `lib/session.ts` and `app/sso/route.ts` are ported
from v1.0 with the user-sync target changed to `app_users`.

---

## D-02 — Schema amendments C-01 and C-02 approved

Both are applied as a clearly-commented addendum in `0001_schema.sql`, after the
supplied schema, so the original remains readable byte-for-byte above it.

**C-01 — transfer idempotency.** `post_stock_movement()` idempotency key becomes
`source_type:source_id:movement:site_id`. Without this, a transfer receipt cannot
post its source-drain and destination-credit legs (both would collide on one
key), stranding stock in `IN_TRANSIT` and permanently overstating group stock.

Existing single-site movements are unaffected — their keys merely gain a stable
site suffix, and no ledger rows exist yet.

**C-02 — QC re-inspection.** `qc_inspections.gate_inward_id` loses its column
`UNIQUE` in favour of:

```sql
CREATE UNIQUE INDEX qc_inspections_gi_original
  ON qc_inspections (gate_inward_id) WHERE is_reinspection_of IS NULL;
```

One original inspection per gate inward, unlimited re-inspections chained off it.
`grns.qc_id UNIQUE` still guarantees one GRN per inspection.

**Nothing else in the supplied schema is altered.** No table, column, enum or
constraint is dropped or redesigned.

---

## ~~D-03 — Database: Supabase PostgreSQL~~ — SUPERSEDED by D-05

Originally: Supabase through the transaction-mode pooler, matching v1.0.
Reversed on 2026-09-23. Kept here so the change is traceable.

---

## ~~D-05 — Google Sheets is the system of record~~ — SUPERSEDED by D-06

Crystal has no PostgreSQL instance available for this project. The system of
record is the workbook **"New Procurement 2.0"**
(`1d9quFEitiHHFB2JSC6tLlCvFqP3TkRux0eVU0hNkQgg`), owned by apps@crystalgroup.in.

Reached through the Sheets API v4 using the existing service account
`crystal-procurement-service@crystalcore.iam.gserviceaccount.com` (v1.0's, from
the `crystalcore` GCP project). The workbook must be shared with that address as
**Editor**.

**The SQL schema remains the data model.** Its 61 tables become 61 tabs with the
same columns, the same enums, the same relationships and the same state
machines. What changes is *where enforcement lives*: out of triggers and
constraints, into a single server-side service layer that is the only writer.
`db/migrations/0001_schema.sql` stays in the repository as the authoritative
specification of that model, and `npm run verify:schema` still runs against it.

### What this costs

These were raised before the decision and confirmed. They are real, and they are
listed here so nobody is surprised by them later.

| Guarantee | In PostgreSQL | On Sheets |
|---|---|---|
| Document numbering | `next_document_no()`, atomic | **Mitigated** — atomic `values.append` sequencing, see `docs/05-sheets-architecture.md` |
| Multi-step atomicity | `BEGIN … COMMIT` | **Partly** — single `batchUpdate` where possible, write-ahead journal with recovery otherwise |
| Stock never negative | `CHECK (qty >= 0)` | **Mitigated** — serialised writes + balances rebuildable from the ledger |
| Ledger/audit immutable | `forbid_mutation()` trigger | **Weakened** — protected ranges stop editors, hash chain makes tampering detectable; the workbook **owner can always bypass** |
| Uniqueness (PAN, GSTIN, invoice, challan) | unique indexes | **Weakened** — checked under the write lock; a determined concurrent write can still slip through |
| Referential integrity | foreign keys | **Weakened** — service-layer checks plus a nightly orphan report |
| Segregation of duties | triggers | **Weakened** — service layer only, which brief §31 warns against |
| Calculations | views | **Moved** — one TypeScript module, mirrored into computed tabs so humans see the same numbers |
| Throughput | thousands/sec | **Limited** — ~60 writes/min/user; a caching and batching layer is mandatory, not optional |

**The honest summary:** correctness under *normal* single-user-at-a-time
operation is achievable and is what this build targets. Correctness under
genuine concurrent load, and tamper-proofing against the workbook owner, are
not achievable on Sheets. If Crystal later gets any PostgreSQL instance —
managed, self-hosted or local — the repository interface in `lib/sheets/repo.ts`
is the seam to swap, and `0001_schema.sql` is ready to apply unchanged.

**Consequence for the brief** — §3, §16, §28, §29, §30 and §31 are met as far as
the platform allows, with the gaps above documented rather than papered over.
No code will claim a guarantee it does not have.

**Reversed on 2026-09-23** when a local PostgreSQL 18 turned out to be
available. Kept in full because the analysis of what Sheets costs is the
justification for D-06, and because the measurements in it — particularly that
`values.append` does not return a dependable row index — are worth keeping on
record if anyone proposes a spreadsheet store again.

---

## D-06 — PostgreSQL 18, local, is the system of record

Crystal has PostgreSQL 18 running locally on port 5432. The supplied schema is
applied to a `crystal_procurement` database there, and it is authoritative again
in the full sense: triggers, CHECK constraints, unique indexes, generated
columns, `post_stock_movement()` and `next_document_no()` all do the enforcing.

`db/migrations/0001_schema.sql` is the supplied schema plus the two approved
amendments (D-02); `0002_reference_data.sql` seeds the workflow rules;
`0003_site_code_immutable_widen.sql` applies conflict C-24.

### What this restores

Everything D-05 listed as lost or weakened:

| Guarantee | On Sheets | On PostgreSQL |
|---|---|---|
| Document numbering | token-claim workaround | `next_document_no()` — one atomic statement |
| Multi-step atomicity | write-ahead journal, partial writes possible | `BEGIN … COMMIT`, nothing partial survives |
| Stock never negative | app check under a lock, beatable | `CHECK (qty >= 0)` — no window at all |
| Ledger/audit immutable | protected ranges + hash chain, owner could bypass | `forbid_mutation()` trigger — nobody bypasses |
| Uniqueness | lock-and-check, racy | unique indexes |
| Referential integrity | nightly orphan report | foreign keys |
| Segregation of duties | service layer only | triggers, re-checked in the service |
| Calculations | TypeScript, mirrored into tabs | the views, authoritative |
| Throughput | ~60 writes/minute | not a consideration |

### What carried over unchanged

The move cost less than it might have, because the layering held: the SSO
route, the session module, the permission matrix, the error mapper, every API
route, every screen, the validation library and the encryption module were all
written against interfaces rather than against the store. What changed was
`lib/db.ts`, the three services, and the scripts.

`lib/pg/decimal.ts` survives as fixed-point arithmetic for the client and for
in-app checks — postgres.js returns `numeric` as a string precisely so it never
touches a float, and that discipline is worth keeping either way.

### What this costs

A local database is not reachable from a deployment. Running this anywhere but
the machine PostgreSQL is on needs either a hosted instance or a tunnel. That is
a deployment question, not an architecture one, and the connection string is the
only thing that changes.

---

## D-04 — Roles: collapse the three "Head of" personas onto `CG_FHEAD`

Head of Supply Chain, Head of Operations and Head of Finance all map to
`CG_FHEAD`. They are separated by **site and approval band**, not by role — the
approver for any given decision is selected from `approval_band_levels`, seeded
per `entity_type`.

**Consequence** — the `role_code` enum is used exactly as supplied. The full
prototype-label → `role_code` mapping is in `docs/02-conflict-register.md` (C-12)
and is the single source of truth for every UI label.

**Revisit if** — Crystal needs Finance genuinely unable to approve a supply-chain
award. That requires three new enum values and a re-seed of the approval matrix.

---

## D-07 — Group-wide entities are scoped with `null`, never site `0`

Raised by a defect, not by design: a Functional Head could not approve a vendor.
The refusal read *"You do not have permission to approve this vendor at this
site."* — which was true, and meaningless, because a vendor is not at a site.

`transitionVendor()` passed `siteId: 0`. `rolesAt(principal, 0)` looks for a site
with id `0`, finds none, and falls back to returning **only group-wide roles**
(`CG_ADM`, `CG_DIR`). `CG_FHEAD` is site-scoped, so the set came back empty and
the check refused. The fallback is correct; `0` as an argument to it was not.

The bug hid because `CG_ADM` is group-wide, so every path an administrator
exercised passed. It surfaced only in `verify:procurement`, which walks the chain
with five *distinct* people — including a Functional Head who is not also an
administrator. That is the argument for keeping the verification cast separate.

### The rule

`TransitionRequest.siteId` is `number | null`:

| value | meaning |
|---|---|
| a site id | the permission must be held **at that site** — the default, and correct for every record carrying a `site_id` |
| `null` | the entity is **not site-scoped**; holding the permission anywhere is enough |
| `0` | **never** — it silently degrades to group-wide-only and refuses site-scoped roles |

Only entities with no `site_id` column may pass `null`. Today that is `VENDOR`
alone; vendor bank accounts already called `can(…, null)` directly and were
unaffected. Everything else — MR, transfer, PR, PO, GRN, issue, return — belongs
to a site and keeps the stricter check. A Warehouse Lead at Pune still cannot
decide Dhulagarh's transfers.

This does not weaken segregation of duties. Who may act is still decided by the
permission matrix; `vba_maker_checker` still forbids approving one's own
submission; the self-approval checks in `approvals.ts`, `mr.ts`, `pr.ts` and
`transfers.ts` are untouched. What changed is only *where* the role must be
held, for entities that are nowhere.

---

## D-08 — C-26 applied under D-02's amendment principle

Building Phase 5's re-inspection path showed that amendment C-02 was necessary
but not sufficient: it freed `qc_inspections` and left the identical constraint
on `qc_lines`. Migration `0004_qc_lines_reinspection.sql` rescopes that one from
the column to `(qc_id, gate_inward_line_id)`.

This is taken as covered by D-02 rather than raised as a fresh decision, because
it is the same amendment finishing the job it started — the schema intended
re-inspection (`is_reinspection_of` exists), and both constraints were blocking
the intent. The full argument is conflict C-26.

The alternative was a service-level workaround, and it is worth naming why that
was rejected: the only way through without a schema change is to detach or
overwrite the original inspection's lines. `NOT NULL` blocks detaching, and
overwriting destroys the original verdict — which is precisely what C-02 chose
option A to preserve, and what §29 requires. A workaround here would have quietly
undone an approved decision.

---

## Standing rules carried into implementation

1. The schema is authoritative for data and business constraints; the prototype
   is authoritative for UI and UX.
2. Stock changes only through `post_stock_movement()`. No `INSERT INTO
   stock_ledger`, no `UPDATE stock_balances`, anywhere.
3. Document numbers only through `next_document_no()`. Never generated in
   JavaScript.
4. Financial totals and rankings come from the database views, never recomputed
   in application or client code.
5. Permissions and segregation of duties are enforced server-side. Hiding a
   button is presentation only.
6. Every mutating operation runs in one transaction and writes an `audit_log`
   row inside it.
