-- =============================================================================
-- C-26  QC re-inspection was still unreachable, one level down.
--
-- Amendment C-02 fixed qc_inspections: it dropped UNIQUE (gate_inward_id) and
-- replaced it with a partial unique index, so a gate inward can carry one
-- ORIGINAL inspection plus any number of re-inspections chained off it.
--
-- But qc_lines carries the same defect against the same idea:
--
--   gate_inward_line_id bigint NOT NULL UNIQUE REFERENCES gate_inward_lines(id)
--
-- A re-inspection needs its own qc_lines rows, covering the same gate-inward
-- lines as the inspection it follows — that is what "re-inspect" means. The
-- global UNIQUE forbids the second set, so C-02's fix let the parent row be
-- created and then the child insert failed. Re-inspection remained impossible;
-- only the error message moved.
--
-- The rule the column was reaching for is real, but it is scoped to an
-- inspection rather than to all of history: WITHIN one inspection, a
-- gate-inward line is inspected exactly once. Across inspections it may be
-- inspected again, which is the whole point.
--
-- So the constraint becomes composite. Nothing is loosened that mattered:
-- a duplicate line within an inspection is still refused, and grns.qc_id UNIQUE
-- still guarantees one GRN per inspection, so the GRN attaches to whichever
-- inspection is final.
--
-- Conflict register: C-26. Decision: D-02 covers the amendment principle.
-- =============================================================================
BEGIN;

ALTER TABLE qc_lines DROP CONSTRAINT qc_lines_gate_inward_line_id_key;

ALTER TABLE qc_lines
  ADD CONSTRAINT qc_lines_inspection_line_uq UNIQUE (qc_id, gate_inward_line_id);

-- Reading a gate-inward line's inspection history — original, then each
-- re-inspection in order — is how the QC screen shows what changed.
CREATE INDEX qc_lines_gate_inward_line_idx ON qc_lines (gate_inward_line_id);

COMMIT;
