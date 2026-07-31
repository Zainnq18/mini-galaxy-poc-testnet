CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE auth_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address varchar(42) NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_nonces_wallet_idx ON auth_nonces(wallet_address, created_at DESC);

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  wallet_address varchar(42) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_wallet_idx ON sessions(wallet_address, expires_at DESC);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL DEFAULT 80002 CHECK (chain_id = 80002),
  creator_address varchar(42) NOT NULL,
  token_address varchar(42) NOT NULL,
  token_name varchar(120) NOT NULL,
  token_symbol varchar(40) NOT NULL,
  token_decimals smallint NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  title varchar(180) NOT NULL,
  description text NOT NULL DEFAULT '',
  proposals jsonb NOT NULL,
  metadata_hash varchar(66) NOT NULL,
  proposal_config numeric(78,0) NOT NULL,
  record_date_at timestamptz NOT NULL,
  record_date_block bigint,
  snapshot_root varchar(66),
  snapshot_holder_count integer,
  token_to_vote_ratio bigint NOT NULL CHECK (token_to_vote_ratio > 0),
  vote_unit numeric(78,0) NOT NULL CHECK (vote_unit > 0),
  voting_start_at timestamptz NOT NULL,
  voting_end_at timestamptz NOT NULL,
  discovery_mode varchar(24) NOT NULL CHECK (discovery_mode IN ('PUBLIC_ELIGIBLE','SUBSCRIBERS_ONLY','DIRECT_LINK')),
  authenticity_status varchar(24) NOT NULL CHECK (authenticity_status IN ('COMMUNITY','SELF_CLAIMED','TOKEN_OWNER_VERIFIED')),
  snap_delivery_mode varchar(24) NOT NULL CHECK (snap_delivery_mode IN ('DISABLED','ELIGIBLE','SUBSCRIBERS_ONLY')),
  status varchar(24) NOT NULL DEFAULT 'SNAPSHOT_PENDING' CHECK (status IN (
    'SNAPSHOT_PENDING','SNAPSHOT_RUNNING','SNAPSHOT_READY','DEPLOYING',
    'SCHEDULED','OPEN','CLOSED','FAILED'
  )),
  failure_reason text,
  contract_address varchar(42),
  deployment_tx_hash varchar(66),
  deployment_block bigint,
  verification_status varchar(20) NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (verification_status IN ('NOT_SUBMITTED','PENDING','VERIFIED','FAILED')),
  verification_guid text,
  verification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (record_date_at <= voting_start_at),
  CHECK (voting_start_at < voting_end_at)
);
CREATE INDEX events_creator_idx ON events(creator_address, created_at DESC);
CREATE INDEX events_discovery_idx ON events(status, discovery_mode, voting_end_at);
CREATE INDEX events_token_idx ON events(token_address, created_at DESC);
CREATE UNIQUE INDEX events_contract_unique ON events(chain_id, contract_address) WHERE contract_address IS NOT NULL;
CREATE TRIGGER events_updated_at BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE snapshot_entries (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  wallet_address varchar(42) NOT NULL,
  raw_balance numeric(78,0) NOT NULL CHECK (raw_balance > 0),
  voting_power numeric(78,0) NOT NULL CHECK (voting_power > 0),
  merkle_proof jsonb NOT NULL,
  PRIMARY KEY (event_id, wallet_address)
);
CREATE INDEX snapshot_wallet_idx ON snapshot_entries(wallet_address, event_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  voter_address varchar(42),
  type varchar(24) NOT NULL CHECK (type IN ('BUILD_SNAPSHOT','DEPLOY_EVENT','RELAY_VOTE','VERIFY_CONTRACT')),
  dedupe_key text NOT NULL UNIQUE,
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message text NOT NULL DEFAULT 'Queued',
  result jsonb,
  error text,
  attempts smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 6,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs(status, available_at, created_at);
CREATE INDEX jobs_event_idx ON jobs(event_id, created_at DESC);
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  voter_address varchar(42) NOT NULL,
  snapshot_balance numeric(78,0) NOT NULL,
  voting_power numeric(78,0) NOT NULL,
  choices jsonb NOT NULL,
  choices_hex text NOT NULL,
  signature text NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('QUEUED','SUBMITTED','CONFIRMED','FAILED')),
  transaction_hash varchar(66),
  block_number bigint,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, voter_address)
);
CREATE INDEX votes_event_idx ON votes(event_id, status);
CREATE UNIQUE INDEX votes_tx_unique ON votes(transaction_hash) WHERE transaction_hash IS NOT NULL;
CREATE TRIGGER votes_updated_at BEFORE UPDATE ON votes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE relayer_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  voter_address varchar(42),
  type varchar(20) NOT NULL CHECK (type IN ('DEPLOY_EVENT','RELAY_VOTE')),
  nonce bigint NOT NULL,
  transaction_hash varchar(66) NOT NULL UNIQUE,
  raw_transaction text NOT NULL,
  predicted_contract_address varchar(42),
  status varchar(16) NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED','BROADCAST','CONFIRMED','REVERTED')),
  receipt jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nonce)
);
CREATE TRIGGER relayer_transactions_updated_at BEFORE UPDATE ON relayer_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE snap_subscriptions (
  wallet_address varchar(42) NOT NULL,
  token_address varchar(42) NOT NULL,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, token_address)
);

CREATE TABLE communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category varchar(32) NOT NULL CHECK (category IN ('EVENT_ANNOUNCEMENT','VOTING_OPEN','DEADLINE_REMINDER','DOCUMENT_UPDATE','RESULTS_AVAILABLE','GENERAL')),
  audience varchar(24) NOT NULL CHECK (audience IN ('ALL_ELIGIBLE','NOT_VOTED','SUBSCRIBERS')),
  title varchar(180) NOT NULL,
  body text NOT NULL,
  action_url text NOT NULL,
  published_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  creator_signature text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > published_at)
);
CREATE INDEX communications_event_idx ON communications(event_id, published_at DESC);
