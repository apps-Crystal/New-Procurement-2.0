-- =============================================================================
-- C-27  ADJUSTMENT is a movement type with nothing to move it.
--
-- `movement_type` includes 'ADJUSTMENT', and stock_ledger requires every entry
-- to name its source:
--
--   source_type text NOT NULL,   -- GRN_LINE, TRANSFER_LINE, DAMAGE_REPORT, …
--   source_id   bigint NOT NULL,
--   idempotency_key text NOT NULL UNIQUE  -- source_type:source_id:movement:site_id
--
-- Every other source_type in that list is a row in a table, and
-- `stock_ledger_source_idx ON (source_type, source_id)` exists so that "what
-- caused this movement" can be answered. ADJUSTMENT has no such table, which
-- leaves two problems:
--
--   1. source_id would have to point at nothing. The source index stops
--      answering its question for exactly the movements that most need
--      explaining — the ones where the system was simply wrong.
--
--   2. Worse, the idempotency key would not be unique. Any scheme built from
--      (site, item) makes a SECOND stock-take of the same item at the same site
--      collide with the first, and post_stock_movement() treats a key collision
--      as a replay: it returns the original entry and posts nothing. The second
--      count would silently do nothing at all.
--
-- A stock take is also a business record in its own right — who counted, when,
-- what the system said, what they found, and why the difference. The audit log
-- records that it happened; it is not where a warehouse looks it up.
--
-- So ADJUSTMENT gets the table the schema's own design implies. Nothing is
-- changed; a missing piece is added.
--
-- Conflict register: C-27.
-- =============================================================================
BEGIN;

CREATE TABLE stock_adjustments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adj_no         text   NOT NULL UNIQUE,                    -- ADJ-DHU-Sep2026/0007
  site_id        bigint NOT NULL REFERENCES sites(id),
  item_id        bigint NOT NULL REFERENCES items(id),
  location_id    bigint REFERENCES storage_locations(id),   -- informational (C-18)
  qty_system     numeric(14,3) NOT NULL CHECK (qty_system >= 0),
  qty_counted    numeric(14,3) NOT NULL CHECK (qty_counted >= 0),
  -- Generated, so the movement can never disagree with the count behind it.
  delta          numeric(14,3) GENERATED ALWAYS AS (qty_counted - qty_system) STORED,
  reason         text   NOT NULL,
  counted_by     bigint NOT NULL REFERENCES app_users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A count that matches posts no movement, so it is not recorded here either.
  CONSTRAINT stock_adj_differs CHECK (qty_counted <> qty_system),
  CONSTRAINT stock_adj_reason  CHECK (length(btrim(reason)) >= 4)
);

CREATE INDEX stock_adjustments_site_item_idx ON stock_adjustments (site_id, item_id, created_at);

-- There is deliberately no stock_entry_id column. The link already exists in
-- the other direction — stock_ledger (source_type = 'ADJUSTMENT', source_id)
-- points here, and stock_ledger_source_idx is the index for exactly that
-- lookup. A second copy of the same fact could only ever go stale.
--
-- An adjustment is evidence of a discrepancy, so editing one away would defeat
-- the point: it is append-only like the ledger it explains. Nothing needs to
-- update it after insert, which is what makes that affordable.
CREATE TRIGGER stock_adjustments_append_only BEFORE UPDATE OR DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
