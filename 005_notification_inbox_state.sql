CREATE TABLE IF NOT EXISTS wallet_notification_state (
  wallet_address varchar(42) PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_read_at IS NULL OR last_read_at >= started_at)
);

-- Existing, already-known wallets start with a fresh inbox when this migration
-- is applied. Future wallets are initialized on their first inbox, token
-- subscription, or browser-push registration.
INSERT INTO wallet_notification_state(wallet_address)
SELECT wallet_address
  FROM (
    SELECT wallet_address FROM snap_subscriptions
    UNION
    SELECT wallet_address FROM web_push_subscriptions
    UNION
    SELECT voter_address AS wallet_address FROM votes
    UNION
    SELECT creator_address AS wallet_address FROM events
  ) known_wallets
 WHERE wallet_address IS NOT NULL
ON CONFLICT(wallet_address) DO NOTHING;
