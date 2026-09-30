# Crystal Procurement & Assets — how the system works

For everyone who uses it: the people who ask for things, buy them, receive them,
inspect them, store them and pay for them.

This explains *why* the system behaves the way it does. If you want the
click-by-click version, read [the operating guide](06-operating-guide.md)
instead.

---

## What it is for

One record of everything Crystal buys and owns, from the moment somebody says
"we need this" to the moment the invoice is paid and the asset is on the
register — across every site, with one version of the truth.

It replaces a set of spreadsheets. The difference is not that it is prettier.
It is that a spreadsheet lets you type any number in any cell, and this does
not.

---

## Five ideas that explain everything else

Almost every "why won't it let me…" has one of these behind it.

### 1 · Everything belongs to a site

Every request, order, delivery and unit of stock is at a site. Your permissions
are held **at a site** too, not in general — a Site Manager at Dhulagarh is not
a Site Manager at Dankuni, and will not see Dankuni's work.

Two roles are exceptions and see everything: **Administrator** and **Director**.

### 2 · Nothing is bought before the group has been searched

When a material request is stock-checked, the system looks at every other site
for the same item. It only counts stock a site holds **above its own reorder
level** — so no site is stripped bare to supply another.

Whatever the group can cover becomes an internal transfer. Only the remainder
becomes a purchase. **You never type the quantity to buy**; it is what is left
after the search.

### 3 · Nobody signs off their own work

This is the single most important rule in the system, and it is enforced in the
database, not by politeness:

- the person who raised a request cannot approve it
- the person who created a vendor cannot approve it
- the person who proposed bank details cannot approve them
- the person who received goods cannot be the one who inspects them
- the inspector who put stock on hold cannot decide the hold

If a button you expect is missing, this is usually why. It is not a permission
you are missing — it is a step that belongs to somebody else.

### 4 · Stock is a consequence, never a keystroke

There is no screen anywhere that lets you set a stock figure. Stock changes only
because something happened: a receipt was approved, a transfer was dispatched,
an issue was made, damage was quarantined.

Every movement is written by one routine, and the balances are derived from the
ledger of those movements. That is why the stock figure and the paper trail can
never disagree — they are the same thing.

The one deliberate exception is a **stock take**, which records a counted
difference *as an adjustment movement*, with a reason. Even correcting stock
leaves a trail.

### 5 · Every number on screen comes from a query, not from memory

Nothing is copied forward and left to rot. A purchase request's value, a
quotation's ranking, a site's stock position, a vendor's scorecard — each is
calculated when you look at it, from the records underneath.

The dashboard names the query behind each tile for exactly this reason.

---

## Who does what

Ten roles. Most people hold one; some hold two at a small site.

| Role | What they do |
|---|---|
| **Requester** | Raises material requests, says why they are needed |
| **Site Manager** | Stock-checks, approves requests, decides QC holds, approves receipts |
| **Buyer** | Purchase requests, vendors, quotations, awards, purchase orders |
| **Site Receiver** | Logs deliveries in at the gate and counts them |
| **QA/QC Inspector** | Inspects what arrived; accepts, holds or rejects |
| **Warehouse Lead** | Goods receipts, stock issues, storage locations, transfers |
| **Accounts** | Invoices, debit and credit notes, reconciliation against Tally |
| **Functional Head** | Approves vendors, bank details and higher-value requests |
| **Director** | The top approval band, group-wide |
| **Administrator** | Master data, users and roles |

A role is always granted **at a site**. Administrator and Director carry across
all of them.

---

## The journey of a purchase

Nine steps, at least six different people. Each record is created *from* the one
before it — you cannot start in the middle.

### Somebody needs something

A **material request** says what a site needs and by when. It is not yet a
purchase; it is a need.

It then gets **stock-checked** against the whole group, and **declared** — a
written business impact of at least forty characters, charged to a budget code
and split across cost heads totalling 100%. That declaration travels with the
request for eight years, so "urgent" on its own is not an answer.

A **Site Manager** approves it. The requester cannot.

> A material request can end without anything being bought — if the group
> already has the stock, it is fulfilled by transfer instead.

### It becomes a purchase request

A **Buyer** raises a purchase request from the approved material request,
carrying only the quantity the stock check said to buy. Payment terms must
total 100%.

On submission, **its value chooses who approves it**. A small request may need
one signature; a large one climbs through Site Manager, Functional Head and
Director in order. Level 2 cannot decide before level 1 has, and a rejection at
any level ends the whole chain.

### Vendors quote

Only **approved** vendors can quote, and each quotation must cover every line so
they can be compared at all.

They are ranked by **landed cost** — freight and tax included — not by the
headline rate, because the cheapest rate with expensive freight often is not the
cheapest. Awarding anything other than the lowest needs a written justification
and its own approval.

Losing quotations are marked lost. Nothing is ever deleted.

### An order is issued

The **purchase order** is drawn from the award, at the awarded rates. It cannot
be issued without a Tally reference, and a blocked vendor cannot be ordered from
at all.

### It arrives — and three people handle it

This is where the system is most deliberate.

1. The **Site Receiver** logs the delivery at the gate: vehicle, challan,
   transporter, and *what was actually counted* against what the challan claims.
   A shortfall raises its own case automatically.

   **Nothing is stock yet.** It has been counted, not accepted.

2. The **QA/QC Inspector** inspects it. Each line is accepted, held or rejected,
   and the three must add up to what was delivered. Anything held or rejected
   needs a reason code. Cold-chain goods cannot be signed off without their
   temperature logger attached.

3. A **hold is a question, not a verdict.** Somebody senior — not the inspector
   who raised it — grants a concession or rejects it. Until then **no receipt
   can be raised at all**.

4. The **Warehouse Lead** raises the goods receipt for what QC accepted, and a
   **Site Manager** approves it.

   *That approval is the moment stock exists.*

### Then it is paid for

**Accounts** books the vendor invoice and runs a three-way match — order,
receipt, invoice. Where they disagree, the invoice is held or disputed rather
than quietly paid. Shortfalls and returns become debit notes, and the vendor's
credit note is matched against them.

Finally the portal is **reconciled against Tally**, line by line, and a run
cannot be closed while a difference remains.

---

## Stock, in six buckets

Stock is never just a number. Every quantity sits in one of six states:

| Bucket | Means |
|---|---|
| **Available** | Free to issue |
| **Reserved** | Promised to a transfer that has not left yet |
| **In transit** | Dispatched to another site, not yet received |
| **Damaged hold** | Quarantined after a damage report |
| **Under repair** | Out of stock while being fixed |
| **Written off** | Gone, but still on the record |

Stock moves only through recognised movements — a receipt, an issue, a transfer
out or in, a quarantine, a repair, a write-off, a return to vendor, an
adjustment, or a reversal. Each one names the document that caused it, so any
figure can be traced back to the paper.

**Reversals do not erase.** A mistaken movement is corrected by a compensating
movement, both visible. The history of a mistake is part of the record.

---

## Reading a document number

```
GRN-DHU-Sep2026/0001
 │    │     │      └── sequence, restarting each month
 │    │     └───────── month and year
 │    └─────────────── site
 └──────────────────── what kind of record
```

Numbers are issued by the system, in order, with no gaps and no duplicates —
even when two people press the button at the same instant. You cannot choose
one, and you cannot reuse one.

---

## When the system refuses you

Refusals are written to be read by the person in front of them. The four you
will meet most:

**"You created this, so you cannot approve it."**
Working as intended. Somebody else has to look at it. See idea 3.

**"…cannot be changed once it has been approved."**
This applies to everybody, whatever their role — it is about the record's state,
not your permissions. Approved things are frozen because other records now
depend on them.

**"This needs a Tally reference."**
The system will not create something in Crystal's books that finance cannot
trace back.

**"…still has stock on conditional hold."**
Somebody has to decide the held quantity before the goods receipt can go ahead.

---

## Vendors, and why they are slow on purpose

A vendor goes **draft → pending → approved**, and can be **blocked** at any
point, which takes effect immediately on every site.

Bank details have their own two-person check, separate from the vendor's. They
are proposed by a Buyer or Accounts and approved by a Functional Head — never
the same person, and only one approved account per vendor at a time.

Account numbers are **encrypted**. Only the last four digits are ever shown on
screen, and the full number is never written to the audit trail, not even in
passing. This is the control that stops an invoice being paid to a changed
account.

KYC documents — GST certificate, PAN card, cancelled cheque, MSME certificate —
are uploaded and stored, not linked. Each file is fingerprinted when stored and
checked again every time it is downloaded, so a document altered afterwards is
refused rather than served. A link to somebody else's server would not survive
eight years of retention.

---

## The audit trail

Every create, change, approval, rejection and override is recorded with who,
when, from where, and what changed — including the things that were refused.

You can read it two ways: as a stream of everything that happened, filtered by
kind of record or by action; or as one record's own history, in order, which is
usually what somebody actually wants during a dispute.

Overrides are findable on purpose. When somebody with authority accepts a
variance the system flagged, that decision is a record in its own right.

---

## The screens

| Group | Screen | For |
|---|---|---|
| **Overview** | Dashboard | Live figures, each naming the query behind it |
| | Pending approvals | Everything waiting on *you*, right now |
| **Inventory** | Warehouse stock | What is where, in which bucket |
| | Stock ledger | Every movement, newest first |
| | Stock issues | Giving stock out to a department |
| | Asset register | Serialised units and their history |
| | Damaged & missing | Damage reports through to write-off |
| **Procurement** | Material requests | Needs, stock checks, declarations |
| | Stock transfers | Moving stock between sites |
| | Purchase requests | Requests, approvals, value bands |
| | Vendor quotations | Comparison and award |
| | Purchase orders | Issued orders and what is outstanding |
| **Receiving** | Gate inward | Deliveries as counted at the gate |
| | QA/QC inspection | Verdicts and conditional holds |
| | Goods receipt | Receipts — where stock begins |
| | Shortfalls | Short deliveries awaiting a decision |
| | Purchase returns | Sending goods back |
| **Accounts** | Vendor invoices | Booking and three-way matching |
| | Debit & credit notes | Recovering shortfalls and returns |
| | Vendor reconciliation | Portal against Tally |
| **Vendors** | Vendor master | Registration, approval, bank, KYC |
| **Administration** | Master data | Sites, locations, items, budgets, users & roles |
| | Audit trail | Everything that has happened |

You will only see the screens your roles allow. A screen you cannot see is not
broken — it belongs to somebody else's job.

---

## Letting another system in

Everything the screens do goes through an API, and that API is open to other
software — a Tally bridge, a mobile client, a scheduled export — through an
**API token**.

**Administration → Master data → API tokens**, then *Issue a token*.

A token **acts as a person you choose**. It can do what they can do, at the
sites they hold a role at, and nothing else. So pick the narrowest account that
does the job: a token for a reporting dashboard should act as somebody who can
only read reports.

Two things are worth understanding before you issue one.

**Read-only is the default, and usually right.** Most integrations only need to
read. A read-only token is refused anything but a GET, which is the difference
between a leaked credential that is embarrassing and one that raises purchase
orders.

**The value is shown once.** Only its fingerprint is stored, so there is no
screen and no support request that can recover it. Lose it and you revoke that
token and issue another — which is the same reason nobody can read yours.

Using one looks like this:

```
Authorization: Bearer cgp_…
```

against any address under `/api`.

Revoking takes effect immediately, and revoked tokens stay on the list: a
credential that existed and was used is part of the history of what happened.

> A token is never widened by the development access switches. Those exist so a
> person testing a chain is not stopped by which hat they are wearing; a token
> is a long-lived credential that could outlive the session that made it, so it
> always gets the real permission rules.

---

## If something looks wrong

The figures are calculated from the records, so a wrong figure means a wrong
record — and the record can be found.

Start from the number, open the document behind it, and read its history in the
audit trail. It will tell you who did what, and when. That is the whole point of
building it this way.
