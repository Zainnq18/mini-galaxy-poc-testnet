CREATE TABLE IF NOT EXISTS relayer_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  voter_address varchar(42),
  chain_id integer NOT NULL,
  relayer_address varchar(42) NOT NULL,
  transaction_type varchar(24) NOT NULL
    CHECK (transaction_type IN ('DEPLOY_EVENT','RELAY_VOTE')),
  nonce bigint NOT NULL CHECK (nonce >= 0),
  transaction_hash varchar(66) NOT NULL UNIQUE,
  raw_transaction text NOT NULL,
  predicted_contract_address varchar(42),
  status varchar(20) NOT NULL DEFAULT 'PREPARED'
    CHECK (status IN ('PREPARED','BROADCAST','CONFIRMED','REVERTED')),
  receipt jsonb,
  last_error text,
  broadcast_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id, relayer_address, nonce)
);

CREATE INDEX IF NOT EXISTS relayer_transactions_job_idx
  ON relayer_transactions(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS relayer_transactions_event_idx
  ON relayer_transactions(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS relayer_transactions_status_idx
  ON relayer_transactions(status, updated_at);

DROP TRIGGER IF EXISTS relayer_transactions_set_updated_at ON relayer_transactions;
CREATE TRIGGER relayer_transactions_set_updated_at BEFORE UPDATE ON relayer_transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
