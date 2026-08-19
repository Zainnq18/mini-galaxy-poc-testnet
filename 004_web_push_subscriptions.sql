CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  endpoint text PRIMARY KEY,
  wallet_address varchar(42) NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS web_push_subscriptions_wallet_idx
  ON web_push_subscriptions(wallet_address);

DROP TRIGGER IF EXISTS web_push_subscriptions_updated_at ON web_push_subscriptions;
CREATE TRIGGER web_push_subscriptions_updated_at
  BEFORE UPDATE ON web_push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
