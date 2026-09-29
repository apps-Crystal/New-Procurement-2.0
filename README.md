# Crystal Procurement & Asset Management 2.0

Procurement and asset management for Crystal Group: material request through
purchase order, receiving and QC, inventory and assets, returns, and vendor
accounts.

Runs on **localhost** against **PostgreSQL 18**, using the supplied schema.

Sign-in is currently a **local development picker** — no password, no identity
provider. Crystal Core SSO is built and dormant behind `AUTH_MODE=core`; see
[Authentication](#authentication).

---

## Setup

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL, ADMIN_URL, SESSION_SECRET

npm run db:create              # create the crystal_procurement database
npm run migrate                # apply db/migrations in order
npm run verify:db              # prove it works, end to end, on a throwaway copy

# The first administrator. Granting a role needs CG_ADM, and a role is granted
# AT a site — so an empty database cannot produce its own first admin.
# Substitute your own site details; PowerShell treats < and > as operators, so
# do not leave angle-bracket placeholders in the line you run.
npm run bootstrap:admin -- you@crystalgroup.in --site DHU --name Dhulagarh --state 19 --gstin 19AABCU9603R1ZX --tally CC-DHU

npm run dev
```

The GSTIN must begin with the state code (19 = West Bengal) and is what decides
CGST/SGST versus IGST on every invoice, so it is worth getting right. Omit
`--tally` to create the site INACTIVE and fill the cost centre in later.

Then open <http://localhost:3000> and pick your user at `/signin`.

---

## Authentication

Two modes, set by `AUTH_MODE` in `.env.local`.

**`local` (current).** `/signin` lists the users in `app_users`; pick one and you
are them. **There is no password** — anyone who can reach the server can be
anyone. That is fine on localhost and unsafe anywhere else, so the route refuses
to run in a production build unless `ALLOW_LOCAL_AUTH=1` is set deliberately.

**`core`.** Crystal Core mints a short-lived launch token and redirects to
`/sso?token=…`, which verifies it with Core before any session exists. The code
for this is written and tested; switching `AUTH_MODE=core` turns it on.

Both paths mint the *same* signed session cookie, so everything downstream is
identical: the principal is looked up from `user_site_roles` on every request,
site scoping applies, and segregation of duties is enforced by the database.
Only the way identity is asserted differs.

When Core is switched on, users created locally carry over — `/sso` matches on
email and re-points the row, keeping all of that user's history.

---

## Status

| Phase | | |
|---|---|---|
| 1 · Analysis | ✅ | `docs/` — architecture map, conflict register, screen/API map, plan |
| 2 · Foundation | ✅ | Database, SSO, authorisation, audit, errors, stock service, UI shell |
| 3 · Master data | ✅ | Sites, locations, item classes, items, budget codes, roles, checklists, vendor lifecycle + bank maker-checker |
| 4 · Procurement | ⬜ | |
| 5 · Receiving | ⬜ | |
| 6 · Inventory | ⬜ | |
| 7 · Returns | ⬜ | |
| 8 · Accounts | ⬜ | |
| 9 · Dashboard | ⬜ | |
| 10 · Hardening | ⬜ | |

---

## Read these first

| Document | What it settles |
|---|---|
| [`docs/00-decisions.md`](docs/00-decisions.md) | Binding decisions, including why the store moved twice |
| [`docs/01-architecture-map.md`](docs/01-architecture-map.md) | Modules, entities, state machines, role matrix, UI system |
| [`docs/02-conflict-register.md`](docs/02-conflict-register.md) | Every prototype-vs-schema conflict and the rule that resolves it |
| [`docs/03-screen-api-map.md`](docs/03-screen-api-map.md) | Screen → entity → API, validation table, stock movement table |
| [`docs/04-implementation-plan.md`](docs/04-implementation-plan.md) | Phases and their gates |
| [`docs/05-sheets-architecture.md`](docs/05-sheets-architecture.md) | Superseded. Kept for what it measured about spreadsheet stores. |
| [`docs/06-operating-guide.md`](docs/06-operating-guide.md) | Walking the chain by hand: who signs in, which screen, what to press |
| [`docs/07-user-guide.md`](docs/07-user-guide.md) | How the system works, for the people who use it |

---

## Commands

| Command | |
|---|---|
| `npm run dev` | development server |
| `npm run build` | production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Jest — architecture invariants, decimal maths, validation |
| `npm run db:create` | create the application database |
| `npm run migrate` | apply pending migrations |
| `npm run migrate -- --status` | show what has and has not run |
| `npm run verify:schema` | apply the schema to a throwaway PostgreSQL 15 in Docker and assert 30 invariants |
| `npm run verify:db` | exercise the real services against a throwaway database, then drop it |
| `npm run bootstrap:admin -- <email>` | grant the first administrator (and the first site) |
| `npm run dev:session -- <email>` | mint a session cookie for curl or a script |

---

## The four rules

Not style preferences. Each is enforced by a test, and breaking any of them is a
defect regardless of whether the feature works.

**1 · Stock changes only through `post_stock_movement()`.**
`stock_ledger` is append-only by trigger and is the truth; `stock_balances` is a
projection it maintains. Posting is idempotent on
`source_type:source_id:movement:site_id`. A correction is a reversing entry,
never an edit. `lib/services/stock.ts` is the only caller.

**2 · Document numbers come only from `next_document_no()`.**
Never built by string concatenation, never read-increment-write. The schema says
that function exists to fix "the v1.0 read-increment-write race"; v1.0 ran on
Google Sheets and had it.

**3 · The database owns every calculation that gets stored.**
PR totals come from `v_pr_totals`, landed cost and vendor ranking from
`v_quotation_landed_cost`. `lib/pg/decimal.ts` is fixed-point arithmetic for
live previews and in-app checks — never a second implementation of a view, and
never a JS float on a money value.

**4 · Permissions and segregation of duties are server-side.**
Hiding a button is presentation. Every route resolves the caller's roles from
`user_site_roles` on the request, scoped to the record's site. Receiver ≠
inspector ≠ approver, approver ≠ originator — triggers in the schema, re-checked
in the service so the message names a person rather than a constraint.

---

## Layout

```
app/
  (app)/          authenticated screens — the prototype's shell
  api/            route handlers: parse, authorise, call a service, serialise
  signin/         local development picker (AUTH_MODE=local)
  sso/            Crystal Core launch, dormant (AUTH_MODE=core)
lib/
  db.ts           postgres.js client, lazy, plus inTransaction()
  doc-no.ts       the only caller of next_document_no()
  services/       business logic; owns the transaction boundary
  auth/           session, principal, permission matrix, auth mode
  pg/decimal.ts   fixed-point arithmetic for money and quantities
  enums.ts        the schema's enums, for dropdowns and checks
  validate.ts     formats and normalisation, ahead of the constraints
  crypto.ts       AES-256-GCM for vendor bank account numbers
  errors.ts       constraint name / SQLSTATE → business-readable message
  audit.ts        the audit trail writer
  transitions.ts  state machine guard, backed by status_transitions
  client/         browser-side fetch and the six screen states
components/       shared UI, styled by the prototype's own CSS
db/migrations/    0001 schema (+ approved amendments), 0002 reference data, 0003 C-24
prototype/        the original clickable prototype — UI reference
docs/             analysis and decisions
```

## Source material

`db/crystal_procurement_schema.sql` is the supplied schema, unmodified.
`db/migrations/0001_schema.sql` is that file plus a clearly-commented amendment
section (`docs/00-decisions.md` D-02). `prototype/` is the supplied clickable
prototype and is the visual reference for every screen.
