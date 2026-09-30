-- =============================================================================
-- API tokens — machine access to the same API the browser uses.
--
-- Every one of the hundred routes has been reachable only with a session
-- cookie, so nothing outside a browser could call them: no Tally bridge, no
-- mobile client, no scheduled export.
--
-- The shape chosen, and why:
--
--   A token ACTS AS AN EXISTING USER. It is not a second authorisation scheme.
--   `user_id` is not optional, so the permission matrix, the site scoping, the
--   segregation of duties and the audit trail all apply to a token call exactly
--   as they do to that person. A token can never do something its holder could
--   not, and revoking the person's roles revokes the token's reach at the same
--   moment. The alternative — tokens with their own scopes — means a second set
--   of rules to keep in step with the first, and they drift.
--
--   THE TOKEN IS NEVER STORED. Only its SHA-256. There is no code path that can
--   print an existing token, because the value does not exist anywhere after
--   the response that created it. A leaked database gives an attacker hashes of
--   256-bit random strings, which is not a useful thing to have.
--
--   SHA-256 rather than bcrypt is correct here and would be wrong for a
--   password: the input is 32 bytes of CSPRNG output, not something a human
--   chose, so there is no dictionary to run and no work factor worth paying on
--   every request.
--
--   READ-ONLY IS A FIRST-CLASS OPTION. Most integrations read. A token that can
--   only read is the difference between a leaked credential that embarrasses
--   you and one that issues purchase orders.
-- =============================================================================

CREATE TABLE api_tokens (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Who the token acts as. NOT NULL on purpose: see above.
  user_id       bigint NOT NULL REFERENCES app_users(id),

  -- What it is for, in words. Shown in the list; the only way to tell two
  -- tokens apart once neither value is visible.
  name          text   NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),

  -- First characters of the token, for recognising it in a list and in logs.
  -- Not secret, and not enough to authenticate with.
  prefix        text   NOT NULL,

  -- SHA-256 of the whole token, hex. Unique so a lookup is a single indexed
  -- probe rather than a scan-and-compare.
  token_hash    char(64) NOT NULL UNIQUE,

  -- A read-only token is refused any method other than GET.
  read_only     boolean NOT NULL DEFAULT true,

  expires_at    timestamptz,
  last_used_at  timestamptz,

  revoked_at    timestamptz,
  revoked_by    bigint REFERENCES app_users(id),

  created_by    bigint NOT NULL REFERENCES app_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Revocation is recorded, not deleted: a token that once existed and was used
  -- is part of the history of what happened.
  CONSTRAINT api_tokens_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT api_tokens_expiry_future CHECK (expires_at IS NULL OR expires_at > created_at)
);

-- Live tokens for one person, the common listing.
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id) WHERE revoked_at IS NULL;
