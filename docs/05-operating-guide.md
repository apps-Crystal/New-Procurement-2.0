# Operating the system by hand

How to walk a purchase from "we need something" to "it is on the shelf and
paid for", clicking rather than scripting. Every step names the person who does
it, the screen it happens on, and what stops you if you try to do somebody
else's step.

Run `npm run seed:users` first. The chain needs eight different people, and that
is not decoration — half the steps refuse whoever did the previous one.

## Switching between people

Local sign-in only, development only. **Switch user** at the bottom of the
sidebar, or go to `/signin`, and pick. The picker shows each person's roles, so
if a screen is missing the reason is usually visible there.

| Person | Email |
|---|---|
| Requester | `requester@crystalgroup.in` |
| Site Manager | `site.manager@crystalgroup.in` |
| Buyer | `buyer@crystalgroup.in` |
| Site Receiver | `receiver@crystalgroup.in` |
| QA/QC Inspector | `qc@crystalgroup.in` |
| Warehouse Lead | `warehouse@crystalgroup.in` |
| Accounts | `accounts@crystalgroup.in` |
| Functional Head | `finance.head@crystalgroup.in` |
| Director | `director@crystalgroup.in` |
| Administrator | `admin@crystalgroup.in` |

## The one thing to understand first

**A record is created from the record above it, not from its own list screen.**

You will not find a "new goods receipt" button on the Goods receipt screen, and
that is deliberate — a receipt has to come from a completed inspection, an
inspection from a delivery, a delivery from an order. Inventing one out of
nothing would break the trail that makes any of it worth having.

So when a list screen has no "add" button, you are on the wrong screen: go back
one step in the chain and look there.

The exceptions — things that genuinely start from nothing — are material
requests, vendors, stock issues, stock transfers, damage reports and invoices.

## The chain

### 1 · The need

**Requester** → Material requests → **Raise a request**

Pick the site, category, when it is needed, and the items. Saved as a draft.

**Requester or Site Manager** → open it → **Run the stock check**

Searches every site for the same item before anything is bought. Only surplus
*above* each holding site's own reorder level counts, so no site is drained to
supply another. What the group can cover becomes a transfer; the rest becomes
the quantity to buy. You never type the purchase quantity — it falls out of
this.

**Requester** → open it → **Declare**

The business impact, in at least 40 characters, against a budget code, split
across cost heads totalling 100%. This is the justification that travels with
the request for eight years.

**Site Manager** → open it → **Approve**

> The requester cannot approve their own request. `mr_self_approval` is a
> database CHECK, not a nicety — there is no route around it.

### 2 · The purchase request

**Buyer** → Purchase requests → **Raise a purchase request**

Built from an approved material request. It carries only the quantities the
stock check said to buy, at the material request's quantities. Payment terms
must total 100%.

**Buyer** → open it → **Submit**

Its value chooses the approval band, and the band's levels become a queue in
order. A small request may need one approval; a large one needs several, ending
at the Director.

**Each named approver** → Pending approvals → approve or reject

> Only the lowest pending level is actionable — level 2 cannot decide before
> level 1 has. The buyer who raised it cannot approve it. A rejection at any
> level ends the whole chain.

### 3 · Quotations and the award

**Buyer** → open the approved PR → record a quotation, once per vendor

Only **approved** vendors can quote. Every quotation must cover every line, so
they can be compared at all.

**Buyer** → compare → **Award**

The comparison ranks by **landed cost** — freight and tax included — not the
headline rate, and the ranking comes from `v_quotation_landed_cost`, not from
sorting in the browser. Awarding anything other than L1 needs a written
justification and its own approval. Losing quotations are marked lost, never
deleted.

### 4 · The order

**Buyer** → from the awarded PR → raise the purchase order → **Issue**

At the awarded rates, for the PR's quantities. Issuing needs a Tally reference,
and a blocked vendor cannot be ordered from at all.

### 5 · Receiving — three different people on purpose

**Site Receiver** → Gate inward → **Log a delivery**

Vehicle, challan, transporter, and what was actually counted against what the
challan claims. Nothing is stock yet — it has only been counted. A shortfall
against the challan raises a case automatically.

**Site Receiver** → **Send to QC**

**QA/QC Inspector** → QA/QC inspection → **See deliveries awaiting QC**

Accept, hold or reject each line. The three must add up to what was delivered.
Anything held or rejected needs a reason code, and a cold-chain class cannot be
signed off without its data logger attached.

**Site Manager** → QA/QC inspection → **Conditional holds**

A hold is a question, not a verdict, and the inspector who raised it may not
answer it. Until somebody decides — concession or reject — **no receipt can be
raised at all.**

**Warehouse Lead** → from the completed inspection → raise the goods receipt

Only what QC accepted, plus anything granted a concession.

**Site Manager** → Goods receipt → **Approve**

> This is the moment stock exists. Every entry goes through
> `post_stock_movement()`; nothing anywhere writes a balance directly.
>
> Whoever received the goods cannot be the one who inspects them, and
> `check_grn_segregation()` enforces it in the database.

### 6 · Afterwards

| What | Who | Where |
|---|---|---|
| Issue stock to a department | Warehouse Lead | Stock issues → **Issue stock** |
| Book the vendor invoice | Accounts | Vendor invoices → **Book an invoice** |
| Three-way match | Accounts | on the invoice |
| Return rejected goods | Warehouse Lead | Purchase returns |
| Debit note for a shortfall | Accounts | Debit & credit notes |
| Reconcile against Tally | Accounts | Vendor reconciliation |

## Vendors, separately

**Buyer** → Vendor master → **Add vendor** (bank details and KYC optional, on
the same form) → **Send for approval**

**Functional Head** → the vendor → enter the Tally ledger reference → **Approve
vendor**

> Whoever created a vendor cannot approve it. Bank details are their own
> maker-checker: proposed by a Buyer or Accounts, approved by a Functional Head,
> never the same person. Only the last four digits of an account number are ever
> shown, and the number is never written to the audit trail.

## Starting part-way through

Setting up a whole chain by hand to reach step 9 is tedious. Instead:

```
npm run demo:chain -- --upto <stage>
```

runs the chain with the right person at every step and **stops** where you say,
leaving the next step waiting for you. It prints who to sign in as and where to
go.

Stages, in order:

```
vendor  mr  stock-check  declare  approve-mr  pr  submit-pr  approve-pr
quote  award  po  gate  qc  hold  grn  receipt
```

So `--upto award` leaves a purchase order waiting to be raised, and
`--upto gate` leaves a delivery sitting at the gate for QC to inspect. With no
flag it runs the lot.

Each run raises its own material request and carries that one through, so runs
do not collide.

## What has no screen yet

These exist as working API routes with permissions and audit, but nothing in the
UI calls them. They are reachable from the services and from scripts, not by
clicking:

| Operation | Route |
|---|---|
| Publish a QC checklist | `POST /api/master/checklists` |
| Set reorder levels per item and site | `PUT /api/master/item-site-settings` |
| Edit an item | `PATCH /api/master/items/[id]` |
| Edit a site | `PATCH /api/master/sites/[id]` |
| Change the lines on a draft request | `PUT /api/mr/[id]/lines` |
| Withdraw a quotation | `POST /api/quotations/[id]/withdraw` |
| Import the Tally side of a reconciliation | `POST /api/reconciliation/import` |
| Restrict a vendor to item classes | `PUT /api/vendors/[id]/categories` |
| Restrict a vendor to sites | `PUT /api/vendors/[id]/sites` |

The QC checklist one matters most: without a published checklist, an inspection
has no points to tick. `npm run demo:chain` publishes one if the item class has
none, which is why the scripted chain works where clicking would stall.
