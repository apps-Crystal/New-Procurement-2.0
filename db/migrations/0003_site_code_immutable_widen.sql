-- =============================================================================
-- Crystal Procurement 2.0 — widen site_code_immutable()
--
-- Conflict register C-24. The supplied trigger says:
--
--     RAISE EXCEPTION 'Site code % cannot change once transactions exist'
--
-- but only consults material_requests and purchase_orders. A site can hold
-- stock movements, gate inwards, GRNs, transfers, damage reports, issues or
-- purchase returns without either — an opening-balance load alone does it —
-- and the trigger would let such a site be renamed.
--
-- That is not cosmetic. next_document_no() embeds the site code in every
-- number it issues: SL-DHU-Sep2026/0001, GRN-DHU-Sep2026/0022. Renaming DHU to
-- DHUL leaves every document already issued under a code that exists nowhere,
-- with nothing linking old to new.
--
-- Found by the live verification, which expected a site carrying stock ledger
-- entries to refuse a code change and found that it did not.
--
-- This keeps the trigger's stated intent and replaces its incomplete
-- implementation. Nothing else in the supplied schema is altered.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION site_code_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code = OLD.code THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM material_requests  WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM purchase_orders    WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM stock_ledger       WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM gate_inwards       WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM grns               WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM damage_reports     WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM stock_issues       WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM purchase_returns   WHERE site_id      = OLD.id
   UNION ALL SELECT 1 FROM stock_transfers    WHERE from_site_id = OLD.id
   UNION ALL SELECT 1 FROM stock_transfers    WHERE to_site_id   = OLD.id
   LIMIT 1) THEN
    RAISE EXCEPTION 'Site code % cannot change once transactions exist', OLD.code;
  END IF;

  RETURN NEW;
END $$;

COMMIT;
