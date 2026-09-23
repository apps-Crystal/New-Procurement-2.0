# Sheets as the System of Record

How the PostgreSQL data model is carried on Google Sheets without throwing away
the guarantees that can be kept. Decision: `docs/00-decisions.md` D-05.

The design goal is not "store rows in a spreadsheet". It is: **keep the schema's
model and state machines exactly, keep every guarantee the platform can support,
and make the ones it cannot support visibly detectable rather than silently
wrong.**

---

## 1. Mapping

| SQL | Sheets |
|---|---|
| table (61 of them) | tab, same name (`material_requests`, `stock_ledger`, …) |
| column | column, same name, row 1 is a frozen header |
| `bigint GENERATED ALWAYS AS IDENTITY` | `id` column, assigned by the sequencer (§3) |
| enum type | `enums` tab + data validation on the column |
| foreign key | id value + service-layer check + nightly orphan report |
| `CHECK` constraint | service-layer validation, listed in `lib/sheets/schema.ts` |
| trigger | service-layer step, in the same write path |
| view | TypeScript in `lib/calc/*`, mirrored into a `v_*` tab for humans |
| `numeric(14,2)` / `(14,3)` | stored as a plain string, parsed with a fixed-decimal codec — never a JS float |
| `timestamptz` | ISO-8601 UTC string |
| `jsonb` | JSON string |

Tabs are created with an exact grid (`rowCount` 1000, `columnCount` = number of
columns) rather than the default 1000×26. A workbook is capped at 10 million
cells; 61 tabs at the default size would waste over a million on empty columns.

Internal tabs are prefixed `_`: `_seq`, `_journal`, `_locks`, `_meta`.

---

## 2. What the API actually guarantees

Measured against the live workbook, not assumed. Eight simultaneous
`values.append` calls were fired at one tab:

| | Result |
|---|---|
| Rows stored | **8 of 8** — an append never loses or overwrites a row |
| Distinct ranges returned | **3 of 8** — the reported row index is *not* dependable |

So there is exactly one strong guarantee: **an append always lands**. Google
reports the range it planned when the request was built, and concurrent inserts
then shift rows underneath it, so two callers can be told they wrote the same
row while both rows exist elsewhere.

Everything below is built on the guarantee that holds, and nothing relies on the
one that does not. **A row's identity never comes from its position** — it comes
from a token written into the row itself.

This was caught by `npm run verify:live`, which first reported eight concurrent
document numbers collapsing to two distinct values: the v1.0 race, reproduced.

It also means **`stock_ledger` and `audit_log` are naturally safe**: both are
append-only by design, so the one operation Sheets does well is exactly the
operation those two tables need.

---

## 3. Document numbering — atomic without a lock

The schema's comment on `next_document_no()` says it "fixes the v1.0
read-increment-write race". v1.0 ran on Sheets and had that race. We do not
re-introduce it.

Read-increment-write is never performed. Instead:

```
1. values.append a claim row to `_seq` carrying { key, token }
      key   = "<ENTITY>|<SITE_CODE>|<PERIOD>"
      token = a fresh uuid
2. read the key and token columns of `_seq`
3. serial = my token's position among the rows sharing my key
4. number = ENTITY-SITE-PERIOD/lpad(serial, 4)
```

Step 1 cannot lose the row. Step 3 finds the caller's own row **by token, not by
the index the API returned** — that index is unreliable (§2), and trusting it
was precisely the bug the live test caught. Two callers racing find their tokens
at different positions, compute different serials, and both are correct.
No lock, no lost update, no duplicate.

Row ids work the same way: `nextRowId(tab)` claims from the `ID|<tab>` sequence
and the id is written into the row **before** it is appended, so position stops
mattering. A row sorted or moved by hand in the workbook keeps its identity.

**Write budget.** Sheets allows roughly 60 writes a minute, and a stock movement
needs both a ledger id and an entry number. `claimSerials()` appends both claim
rows in one request, so a movement costs three writes (claims, ledger row,
balance) rather than six. The serial write-back is off by default
(`SHEETS_SEQ_WRITEBACK=1` enables it) because it buys traceability, not
correctness. This budget was not theoretical — the first live run exhausted the
quota mid-test.

`_seq` is append-only and doubles as an audit of every number ever issued,
including numbers claimed by operations that later failed — the same gap
behaviour a PostgreSQL sequence has.

---

## 4. Writes — journal, then apply

A business operation (approve a GRN, receive a transfer) touches several tabs.
There is no `BEGIN … COMMIT`.

```
1. compute the ENTIRE change set in memory, validating as we go
2. append one PENDING row to `_journal`: op, actor, payload, timestamp
3. apply the change set:
      - a single values.batchUpdate where all writes are updates
      - appends issued first, updates second, so a crash leaves
        orphan rows rather than dangling references
4. mark the journal row COMMITTED
```

A journal row still `PENDING` after its lease expires is an incomplete
operation. `npm run sheets:recover` reports them and, where the change set is
idempotent (every stock movement is — see §5), rolls it forward. Where it is
not, it reports for a human to resolve rather than guessing.

This is weaker than a transaction. It is not pretending otherwise: what it buys
is that an interrupted operation is always *detectable*, never silently
half-applied.

---

## 5. Stock — the ledger is truth, balances are a cache

This follows the schema's own architecture rather than departing from it.

`stock_ledger` is append-only and carries `idempotency_key`
(`source_type:source_id:movement:site_id`, per amendment C-01). Before
appending, the service reads the key column; if the key exists, the movement has
already been posted and the existing row is returned. Replay-safe, exactly as
`post_stock_movement()` was.

`stock_balances` is a **projection**, which is what the schema always called it.
That means a corrupted balance is recoverable:

```
npm run sheets:rebuild-balances
```

replays the entire ledger and rewrites every balance. Any drift caused by a race
is repairable, because the ledger — the thing that is append-safe — is the
source of truth.

**Never-negative stock** is checked in the service under the write lock (§6).
Under concurrency the check can in principle be beaten; the nightly integrity
job reports any negative balance, and the rebuild corrects the projection. This
is the single biggest honest gap versus `CHECK (qty >= 0)`.

---

## 6. Locking

Two backends, chosen by configuration:

**Apps Script `LockService` (preferred).** `scripts/apps-script/Lock.gs` is a
small web app bound to the workbook exposing `acquire` / `release` backed by
`LockService.getDocumentLock()` — a genuine mutex. One-time deployment; setup
steps in the script's header. Set `SHEETS_LOCK_URL` and `SHEETS_LOCK_TOKEN`.

**Append-queue fallback (no setup).** Appends a claim row to `_locks` and reads
back; the holder is the lowest un-released claim for that key. Built on the same
atomic append as §3, so it is sound, but it costs two round trips and a claim
can be abandoned — claims carry a lease and expire.

Locks are per-key (`stock:<site>:<item>`, `vendor:pan`, …), never global, so
unrelated work proceeds in parallel.

---

## 7. Immutability

| Layer | What it does |
|---|---|
| Protected ranges | `stock_ledger`, `audit_log`, `_seq` and `_journal` are protected via `addProtectedRange` so only the service account can write them. Editors are blocked by Google. |
| Hash chain | Each appended row carries `prev_hash` and `row_hash` (SHA-256 over the row plus the previous hash). Editing any historic row breaks every hash after it. |
| Verification | `npm run sheets:verify-chain` walks the chain and reports the first broken link. |

**The workbook owner can always bypass all of this.** Google gives the owner
unconditional edit rights. The hash chain makes such an edit *detectable*, not
impossible. This is stated plainly rather than hidden, because §29 asks for
immutability and this is as close as the platform gets.

---

## 8. Reading and rate limits

Sheets allows roughly 60 reads and 60 writes per minute per user. A dashboard
with 25 metrics over 61 tabs would exceed that on a single page load.

- **`values.batchGet`** fetches many ranges in one request. The repository
  collects the ranges a request needs and issues one call.
- **Snapshot cache** — an in-process cache keyed by tab with a short TTL, plus
  the workbook's revision id so a stale read is detectable. Dashboards read the
  snapshot, never 25 live queries.
- **Single write queue** — all writes funnel through one in-process queue with
  backoff on `429`, so the app cannot exceed the write quota by fan-out.
- **Computed tabs** — `v_pr_totals`, `v_quotation_landed_cost`,
  `v_po_line_receipt`, `v_stock_position` are written back as real tabs. Humans
  opening the workbook see the same numbers the application does, and the
  dashboard can read one tab instead of aggregating many.

---

## 9. Calculations

Brief §10 requires a single authoritative implementation of landed cost, and §31
forbids duplicating financial logic. With no database, that implementation moves
to `lib/calc/`:

| Module | Replaces | Rule preserved |
|---|---|---|
| `calc/pr-totals.ts` | `v_pr_totals` | per-line GST at each line's own rate, delivery taxed separately |
| `calc/landed-cost.ts` | `v_quotation_landed_cost` | per-line rounding to 2dp, then freight; rank by landed cost |
| `calc/po-receipt.ts` | `v_po_line_receipt` | only `GRN_APPROVED` / `GRN_CLOSED` count |
| `calc/stock-position.ts` | `v_stock_position`, `v_group_surplus` | bucket split, reorder status |
| `calc/vendor-scorecard.ts` | `v_vendor_scorecard` | 12-month rejection %, returns |

Each is a pure function, unit-tested against the SQL it replaces, and is the
only implementation — the UI calls it, the computed tabs are written from it.
Decimal maths uses a fixed-point helper, never JS floats, because
`0.1 + 0.2 !== 0.3` is not acceptable in a GST calculation.

---

## 10. Module layout

```
lib/sheets/
  client.ts     service-account JWT, Sheets API v4, retry + backoff
  schema.ts     the 61 tabs: columns, types, enums, checks — from the SQL
  codec.ts      cell <-> typed value (fixed-decimal, date, enum, json)
  repo.ts       typed read/write; batchGet, batched writes, cache
  seq.ts        document numbering (§3)
  lock.ts       Apps Script or append-queue backend (§6)
  journal.ts    write-ahead journal and recovery (§4)
  chain.ts      hash chain for append-only tabs (§7)
  setup.ts      create tabs, headers, validation, protected ranges
lib/calc/       the views, as pure functions (§9)
```

`lib/services/*` keeps the signatures it already had. The business logic, the
state machine guard, the audit writer, the permission matrix and the error
mapper are unchanged — they call the repository instead of `sql`.

---

## 11. Setup

```bash
npm run sheets:init       # create tabs, headers, enums, validation, protection
npm run sheets:reference  # load status_transitions, approval bands, email config
npm run sheets:doctor     # check access, structure, quota, hash chain
```

The workbook must be shared as **Editor** with
`crystal-procurement-service@crystalcore.iam.gserviceaccount.com`.
