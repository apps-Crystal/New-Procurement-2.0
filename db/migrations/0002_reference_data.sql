-- =============================================================================
-- Crystal Procurement 2.0 — reference data
--
-- This is REFERENCE DATA, not demo data. The schema ships these tables empty
-- but they are load-bearing:
--   * status_transitions  — "the API rejects anything not listed here"
--   * approval_bands      — purchase_requests.approval_band_id points at them
--   * email_config        — notification_outbox.event_key has an FK to it
--
-- Demo/seed transactions live in 0003_seed_demo.sql, which is optional and
-- never applied to production.
--
-- Re-runnable: every insert is guarded.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Status transitions
--
-- permission_key format: <ENTITY>.<ACTION>. The service layer resolves these to
-- roles through lib/auth/permissions.ts; the row here declares that the arrow
-- exists at all. An arrow absent from this table is refused by the API even if
-- the caller holds every role.
-- -----------------------------------------------------------------------------
INSERT INTO status_transitions (entity_type, from_status, to_status, permission_key) VALUES
-- Material request ------------------------------------------------------------
('MR', 'MR_DRAFT',              'MR_STOCK_CHECK',        'MR.STOCK_CHECK'),
('MR', 'MR_STOCK_CHECK',        'MR_DRAFT',              'MR.EDIT'),
('MR', 'MR_STOCK_CHECK',        'MR_STOCK_AVAILABLE',    'MR.STOCK_CHECK'),
('MR', 'MR_STOCK_CHECK',        'MR_STOCK_PARTIAL',      'MR.STOCK_CHECK'),
('MR', 'MR_STOCK_CHECK',        'MR_STOCK_UNAVAILABLE',  'MR.STOCK_CHECK'),
('MR', 'MR_STOCK_AVAILABLE',    'MR_TRANSFER_REQUESTED', 'MR.REQUEST_TRANSFER'),
('MR', 'MR_STOCK_PARTIAL',      'MR_TRANSFER_REQUESTED', 'MR.REQUEST_TRANSFER'),
('MR', 'MR_STOCK_PARTIAL',      'MR_DECLARED',           'MR.DECLARE'),
('MR', 'MR_STOCK_UNAVAILABLE',  'MR_DECLARED',           'MR.DECLARE'),
('MR', 'MR_TRANSFER_REQUESTED', 'MR_TRANSFER_APPROVED',  'MR.TRANSFER_DECIDE'),
('MR', 'MR_TRANSFER_REQUESTED', 'MR_TRANSFER_REJECTED',  'MR.TRANSFER_DECIDE'),
('MR', 'MR_TRANSFER_APPROVED',  'MR_FULFILLED_INTERNAL', 'MR.FULFIL'),
('MR', 'MR_TRANSFER_APPROVED',  'MR_DECLARED',           'MR.DECLARE'),
('MR', 'MR_TRANSFER_REJECTED',  'MR_DECLARED',           'MR.DECLARE'),
('MR', 'MR_DECLARED',           'MR_APPROVED',           'MR.APPROVE'),
('MR', 'MR_DECLARED',           'MR_REJECTED',           'MR.APPROVE'),
('MR', 'MR_APPROVED',           'MR_CONVERTED_TO_PR',    'MR.CONVERT'),
('MR', 'MR_DRAFT',              'MR_CANCELLED',          'MR.CANCEL'),
('MR', 'MR_STOCK_CHECK',        'MR_CANCELLED',          'MR.CANCEL'),
('MR', 'MR_STOCK_AVAILABLE',    'MR_CANCELLED',          'MR.CANCEL'),
('MR', 'MR_STOCK_PARTIAL',      'MR_CANCELLED',          'MR.CANCEL'),
('MR', 'MR_STOCK_UNAVAILABLE',  'MR_CANCELLED',          'MR.CANCEL'),
('MR', 'MR_DECLARED',           'MR_CANCELLED',          'MR.CANCEL'),
('MR', 'MR_APPROVED',           'MR_CANCELLED',          'MR.CANCEL'),

-- Inter-site transfer ---------------------------------------------------------
('TRANSFER', 'TRF_REQUESTED',  'TRF_APPROVED',   'TRANSFER.DECIDE'),
('TRANSFER', 'TRF_REQUESTED',  'TRF_REJECTED',   'TRANSFER.DECIDE'),
('TRANSFER', 'TRF_APPROVED',   'TRF_DISPATCHED', 'TRANSFER.DISPATCH'),
('TRANSFER', 'TRF_DISPATCHED', 'TRF_RECEIVED',   'TRANSFER.RECEIVE'),
('TRANSFER', 'TRF_REQUESTED',  'TRF_CANCELLED',  'TRANSFER.CANCEL'),
('TRANSFER', 'TRF_APPROVED',   'TRF_CANCELLED',  'TRANSFER.CANCEL'),

-- Purchase request ------------------------------------------------------------
('PR', 'PR_DRAFT',     'PR_SUBMITTED', 'PR.SUBMIT'),
('PR', 'PR_SUBMITTED', 'PR_DRAFT',     'PR.RETURN_FOR_EDIT'),
('PR', 'PR_SUBMITTED', 'PR_APPROVED',  'PR.APPROVE'),
('PR', 'PR_SUBMITTED', 'PR_REJECTED',  'PR.APPROVE'),
('PR', 'PR_APPROVED',  'PO_POSTED',    'PR.POST_PO'),
('PR', 'PO_POSTED',    'PR_CLOSED',    'PR.CLOSE'),
('PR', 'PR_DRAFT',     'PR_CANCELLED', 'PR.CANCEL'),
('PR', 'PR_SUBMITTED', 'PR_CANCELLED', 'PR.CANCEL'),
('PR', 'PR_APPROVED',  'PR_CANCELLED', 'PR.CANCEL'),

-- Purchase order --------------------------------------------------------------
('PO', 'PO_DRAFT',              'PO_CREATED',            'PO.ISSUE'),
('PO', 'PO_CREATED',            'PO_PARTIALLY_RECEIVED', 'PO.RECEIVE'),
('PO', 'PO_CREATED',            'PO_RECEIVED',           'PO.RECEIVE'),
('PO', 'PO_PARTIALLY_RECEIVED', 'PO_RECEIVED',           'PO.RECEIVE'),
('PO', 'PO_PARTIALLY_RECEIVED', 'PO_SHORT_CLOSED',       'PO.SHORT_CLOSE'),
('PO', 'PO_RECEIVED',           'PO_CLOSED',             'PO.CLOSE'),
('PO', 'PO_SHORT_CLOSED',       'PO_CLOSED',             'PO.CLOSE'),
('PO', 'PO_DRAFT',              'PO_CANCELLED',          'PO.CANCEL'),
('PO', 'PO_CREATED',            'PO_CANCELLED',          'PO.CANCEL'),

-- Gate inward / QC ------------------------------------------------------------
('GATE_INWARD', 'INWARD_RECEIVED', 'QC_PENDING',       'GATE_INWARD.SEND_TO_QC'),
('GATE_INWARD', 'INWARD_RECEIVED', 'INWARD_REJECTED',  'GATE_INWARD.REJECT'),
('GATE_INWARD', 'QC_PENDING',      'QC_IN_PROGRESS',   'QC.START'),
('GATE_INWARD', 'QC_IN_PROGRESS',  'QC_COMPLETED',     'QC.COMPLETE'),
('GATE_INWARD', 'QC_COMPLETED',    'QC_IN_PROGRESS',   'QC.REINSPECT'),

-- Goods receipt ---------------------------------------------------------------
('GRN', 'GRN_DRAFT',    'GRN_APPROVED', 'GRN.APPROVE'),
('GRN', 'GRN_DRAFT',    'GRN_REJECTED', 'GRN.APPROVE'),
('GRN', 'GRN_DRAFT',    'GRN_FLAGGED',  'GRN.FLAG'),
('GRN', 'GRN_FLAGGED',  'GRN_APPROVED', 'GRN.APPROVE'),
('GRN', 'GRN_FLAGGED',  'GRN_REJECTED', 'GRN.APPROVE'),
('GRN', 'GRN_FLAGGED',  'GRN_DRAFT',    'GRN.UNFLAG'),
('GRN', 'GRN_APPROVED', 'GRN_CLOSED',   'GRN.CLOSE'),

-- Shortfall -------------------------------------------------------------------
('SHORTFALL', 'PENDING', 'AWAIT_BALANCE', 'SHORTFALL.DECIDE'),
('SHORTFALL', 'PENDING', 'SHORT_CLOSE',   'SHORTFALL.DECIDE'),

-- Warehouse damage ------------------------------------------------------------
('DAMAGE', 'DMG_REPORTED',                  'DMG_INSPECTED',                 'DAMAGE.INSPECT'),
('DAMAGE', 'DMG_INSPECTED',                 'DMG_DECISION_PENDING_APPROVAL', 'DAMAGE.DECIDE'),
('DAMAGE', 'DMG_DECISION_PENDING_APPROVAL', 'DMG_UNDER_REPAIR',              'DAMAGE.APPROVE_DECISION'),
('DAMAGE', 'DMG_DECISION_PENDING_APPROVAL', 'DMG_RETURN_RAISED',             'DAMAGE.APPROVE_DECISION'),
('DAMAGE', 'DMG_DECISION_PENDING_APPROVAL', 'DMG_WRITTEN_OFF',               'DAMAGE.APPROVE_DECISION'),
('DAMAGE', 'DMG_UNDER_REPAIR',              'DMG_CLOSED',                    'DAMAGE.CLOSE'),
('DAMAGE', 'DMG_RETURN_RAISED',             'DMG_CLOSED',                    'DAMAGE.CLOSE'),
('DAMAGE', 'DMG_WRITTEN_OFF',               'DMG_CLOSED',                    'DAMAGE.CLOSE'),

-- Purchase return (RTV) -------------------------------------------------------
('RTV', 'RTV_DRAFT',        'RTV_APPROVED',     'RTV.APPROVE'),
('RTV', 'RTV_APPROVED',     'RTV_DISPATCHED',   'RTV.DISPATCH'),
('RTV', 'RTV_DISPATCHED',   'RTV_ACKNOWLEDGED', 'RTV.ACKNOWLEDGE'),
('RTV', 'RTV_ACKNOWLEDGED', 'RTV_CLOSED',       'RTV.CLOSE'),
('RTV', 'RTV_DRAFT',        'RTV_CANCELLED',    'RTV.CANCEL'),
('RTV', 'RTV_APPROVED',     'RTV_CANCELLED',    'RTV.CANCEL'),

-- Vendor ----------------------------------------------------------------------
('VENDOR', 'VENDOR_DRAFT',    'VENDOR_PENDING',  'VENDOR.SUBMIT'),
('VENDOR', 'VENDOR_PENDING',  'VENDOR_APPROVED', 'VENDOR.APPROVE'),
('VENDOR', 'VENDOR_PENDING',  'VENDOR_DRAFT',    'VENDOR.RETURN_FOR_EDIT'),
('VENDOR', 'VENDOR_APPROVED', 'VENDOR_BLOCKED',  'VENDOR.BLOCK'),
('VENDOR', 'VENDOR_BLOCKED',  'VENDOR_APPROVED', 'VENDOR.UNBLOCK'),
('VENDOR', 'VENDOR_APPROVED', 'VENDOR_INACTIVE', 'VENDOR.DEACTIVATE'),
('VENDOR', 'VENDOR_INACTIVE', 'VENDOR_APPROVED', 'VENDOR.ACTIVATE'),

-- Vendor invoice --------------------------------------------------------------
('INVOICE', 'INV_RECEIVED',       'INV_MATCHED',        'INVOICE.MATCH'),
('INVOICE', 'INV_RECEIVED',       'INV_DISPUTED',       'INVOICE.DISPUTE'),
('INVOICE', 'INV_MATCHED',        'INV_PARTIALLY_HELD', 'INVOICE.HOLD'),
('INVOICE', 'INV_MATCHED',        'INV_RELEASED',       'INVOICE.RELEASE'),
('INVOICE', 'INV_MATCHED',        'INV_DISPUTED',       'INVOICE.DISPUTE'),
('INVOICE', 'INV_PARTIALLY_HELD', 'INV_RELEASED',       'INVOICE.RELEASE'),
('INVOICE', 'INV_PARTIALLY_HELD', 'INV_DISPUTED',       'INVOICE.DISPUTE'),
('INVOICE', 'INV_RELEASED',       'INV_PAID',           'INVOICE.PAY'),
('INVOICE', 'INV_DISPUTED',       'INV_MATCHED',        'INVOICE.MATCH'),

-- Debit note ------------------------------------------------------------------
('DEBIT_NOTE', 'DEBIT_NOTE_PENDING',   'DEBIT_NOTE_ISSUED',    'DEBIT_NOTE.ISSUE'),
('DEBIT_NOTE', 'DEBIT_NOTE_ISSUED',    'CREDIT_NOTE_RECEIVED', 'CREDIT_NOTE.RECORD'),
('DEBIT_NOTE', 'DEBIT_NOTE_ISSUED',    'DN_ADJUSTED',          'DEBIT_NOTE.OFFSET'),
('DEBIT_NOTE', 'CREDIT_NOTE_RECEIVED', 'DN_ADJUSTED',          'DEBIT_NOTE.OFFSET'),
('DEBIT_NOTE', 'CREDIT_NOTE_RECEIVED', 'DN_RECONCILED',        'DEBIT_NOTE.RECONCILE'),
('DEBIT_NOTE', 'DN_ADJUSTED',          'DN_RECONCILED',        'DEBIT_NOTE.RECONCILE'),
('DEBIT_NOTE', 'DEBIT_NOTE_PENDING',   'DN_CANCELLED',         'DEBIT_NOTE.CANCEL'),
('DEBIT_NOTE', 'DEBIT_NOTE_ISSUED',    'DN_CANCELLED',         'DEBIT_NOTE.CANCEL'),

-- Vendor reconciliation -------------------------------------------------------
('RECON', 'RECON_OPEN',        'RECON_DIFFERENCE',          'RECON.RESOLVE'),
('RECON', 'RECON_OPEN',        'RECON_RECONCILED',          'RECON.CLOSE'),
('RECON', 'RECON_DIFFERENCE',  'RECON_RECONCILED',          'RECON.CLOSE'),
('RECON', 'RECON_RECONCILED',  'RECON_CONFIRMED_BY_VENDOR', 'RECON.CONFIRM'),
('RECON', 'RECON_RECONCILED',  'RECON_DIFFERENCE',          'RECON.REOPEN')
ON CONFLICT (entity_type, from_status, to_status) DO UPDATE
  SET permission_key = EXCLUDED.permission_key;

-- -----------------------------------------------------------------------------
-- 2. Approval matrix
--
-- Bands mirror the prototype's band() routing. Levels are ordered; level 1 must
-- decide before level 2 is offered. Role mapping per docs/00-decisions.md D-04:
--   Site Manager -> CG_SMGR, Warehouse Lead -> CG_WHL,
--   Head of Supply Chain / Operations / Finance -> CG_FHEAD, Director -> CG_DIR.
-- -----------------------------------------------------------------------------
WITH new_bands (entity_type, min_value, max_value, label) AS (
  VALUES
    -- Purchase request (prototype band(): 1 lakh / 10 lakh breakpoints)
    ('PR',               0::numeric,       100000::numeric,  'Up to ₹1 lakh'),
    ('PR',               100000::numeric,  1000000::numeric, '₹1–10 lakh'),
    ('PR',               1000000::numeric, NULL::numeric,    'Above ₹10 lakh'),
    -- Write-off (prototype damage screen: "Band ₹25,000–2 lakh")
    ('WRITE_OFF',        0::numeric,       25000::numeric,   'Up to ₹25,000'),
    ('WRITE_OFF',        25000::numeric,   200000::numeric,  '₹25,000–2 lakh'),
    ('WRITE_OFF',        200000::numeric,  NULL::numeric,    'Above ₹2 lakh'),
    -- Non-lowest award (prototype: "Routes to Head of Supply Chain")
    ('NON_LOWEST_AWARD', 0::numeric,       1000000::numeric, 'Up to ₹10 lakh'),
    ('NON_LOWEST_AWARD', 1000000::numeric, NULL::numeric,    'Above ₹10 lakh'),
    -- Quote waiver (fewer than the minimum quotations)
    ('QUOTE_WAIVER',     0::numeric,       1000000::numeric, 'Up to ₹10 lakh'),
    ('QUOTE_WAIVER',     1000000::numeric, NULL::numeric,    'Above ₹10 lakh')
)
INSERT INTO approval_bands (entity_type, min_value, max_value, label)
SELECT nb.entity_type, nb.min_value, nb.max_value, nb.label
  FROM new_bands nb
 WHERE NOT EXISTS (
   SELECT 1 FROM approval_bands b
    WHERE b.entity_type = nb.entity_type
      AND b.min_value   = nb.min_value
      AND b.max_value IS NOT DISTINCT FROM nb.max_value);

WITH new_levels (entity_type, label, level_no, role) AS (
  VALUES
    ('PR',               'Up to ₹1 lakh',   1::smallint, 'CG_SMGR'::role_code),
    ('PR',               '₹1–10 lakh',      1::smallint, 'CG_SMGR'::role_code),
    ('PR',               '₹1–10 lakh',      2::smallint, 'CG_FHEAD'::role_code),
    ('PR',               'Above ₹10 lakh',  1::smallint, 'CG_SMGR'::role_code),
    ('PR',               'Above ₹10 lakh',  2::smallint, 'CG_FHEAD'::role_code),
    ('PR',               'Above ₹10 lakh',  3::smallint, 'CG_DIR'::role_code),

    ('WRITE_OFF',        'Up to ₹25,000',   1::smallint, 'CG_WHL'::role_code),
    ('WRITE_OFF',        '₹25,000–2 lakh',  1::smallint, 'CG_WHL'::role_code),
    ('WRITE_OFF',        '₹25,000–2 lakh',  2::smallint, 'CG_FHEAD'::role_code),
    ('WRITE_OFF',        'Above ₹2 lakh',   1::smallint, 'CG_WHL'::role_code),
    ('WRITE_OFF',        'Above ₹2 lakh',   2::smallint, 'CG_FHEAD'::role_code),
    ('WRITE_OFF',        'Above ₹2 lakh',   3::smallint, 'CG_DIR'::role_code),

    ('NON_LOWEST_AWARD', 'Up to ₹10 lakh',  1::smallint, 'CG_FHEAD'::role_code),
    ('NON_LOWEST_AWARD', 'Above ₹10 lakh',  1::smallint, 'CG_FHEAD'::role_code),
    ('NON_LOWEST_AWARD', 'Above ₹10 lakh',  2::smallint, 'CG_DIR'::role_code),

    ('QUOTE_WAIVER',     'Up to ₹10 lakh',  1::smallint, 'CG_FHEAD'::role_code),
    ('QUOTE_WAIVER',     'Above ₹10 lakh',  1::smallint, 'CG_FHEAD'::role_code),
    ('QUOTE_WAIVER',     'Above ₹10 lakh',  2::smallint, 'CG_DIR'::role_code)
)
INSERT INTO approval_band_levels (band_id, level_no, role)
SELECT b.id, nl.level_no, nl.role
  FROM new_levels nl
  JOIN approval_bands b ON b.entity_type = nl.entity_type AND b.label = nl.label
ON CONFLICT (band_id, level_no) DO UPDATE SET role = EXCLUDED.role;

-- -----------------------------------------------------------------------------
-- 3. Notification events
--
-- fixed_to/cc/bcc are addresses that always receive the event, on top of the
-- role-derived recipients the service layer resolves per site. Crystal fills
-- these in through the admin screen; shipped empty and enabled.
-- -----------------------------------------------------------------------------
INSERT INTO email_config (event_key, is_enabled) VALUES
('MR_DECLARED',           true),
('MR_APPROVED',           true),
('MR_REJECTED',           true),
('TRANSFER_REQUESTED',    true),
('TRANSFER_APPROVED',     true),
('TRANSFER_REJECTED',     true),
('TRANSFER_DISPATCHED',   true),
('TRANSFER_RECEIVED',     true),
('PR_SUBMITTED',          true),
('PR_APPROVED',           true),
('PR_REJECTED',           true),
('QUOTATION_REQUESTED',   true),
('QUOTE_AWARDED',         true),
('PO_ISSUED',             true),
('PO_SHORT_CLOSED',       true),
('GATE_INWARD_LOGGED',    true),
('GATE_INWARD_REJECTED',  true),
('QC_PENDING',            true),
('QC_SLA_BREACHED',       true),
('QC_COMPLETED',          true),
('QC_HOLD_PENDING',       true),
('GRN_PENDING_APPROVAL',  true),
('GRN_APPROVED',          true),
('GRN_FLAGGED',           true),
('GRN_REJECTED',          true),
('SHORTFALL_RAISED',      true),
('SHORTFALL_DECIDED',     true),
('DAMAGE_REPORTED',       true),
('DAMAGE_DECISION_PENDING', true),
('WRITE_OFF_APPROVED',    true),
('RTV_RAISED',            true),
('RTV_APPROVED',          true),
('RTV_DISPATCHED',        true),
('RTV_NOT_ACKNOWLEDGED',  true),
('REPLACEMENT_OVERDUE',   true),
('VENDOR_PENDING_APPROVAL', true),
('VENDOR_APPROVED',       true),
('VENDOR_BLOCKED',        true),
('VENDOR_BANK_CHANGE_PENDING', true),
('INVOICE_RECEIVED',      true),
('INVOICE_HELD',          true),
('INVOICE_DISPUTED',      true),
('DEBIT_NOTE_PENDING',    true),
('DEBIT_NOTE_ISSUED',     true),
('CREDIT_NOTE_VARIANCE_FLAGGED', true),
('RECON_DIFFERENCE',      true),
('RECON_COMPLETED',       true),
('LOW_STOCK_DIGEST',      true),
('PENDING_APPROVAL_DIGEST', true)
ON CONFLICT (event_key) DO NOTHING;

COMMIT;
