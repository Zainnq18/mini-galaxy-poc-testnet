CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS auth_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address varchar(42) NOT NULL,
  nonce varchar(96) NOT NULL UNIQUE,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_nonces_wallet_idx
  ON auth_nonces(wallet_address, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash varchar(64) NOT NULL UNIQUE,
  wallet_address varchar(42) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_wallet_idx
  ON sessions(wallet_address, expires_at DESC);

CREATE TABLE IF NOT EXISTS tokens (
  chain_id integer NOT NULL,
  token_address varchar(42) NOT NULL,
  name varchar(120) NOT NULL,
  symbol varchar(40) NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  total_supply numeric(78,0) NOT NULL CHECK (total_supply >= 0),
  optional_owner varchar(42),
  deployment_block bigint,
  standard_status varchar(24) NOT NULL DEFAULT 'VALIDATED'
    CHECK (standard_status IN ('VALIDATED','REVIEW_REQUIRED','UNSUPPORTED')),
  validation_message text,
  validated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id, token_address)
);
DROP TRIGGER IF EXISTS tokens_set_updated_at ON tokens;
CREATE TRIGGER tokens_set_updated_at BEFORE UPDATE ON tokens
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS token_index_cursors (
  chain_id integer NOT NULL,
  token_address varchar(42) NOT NULL,
  last_scanned_block bigint NOT NULL,
  last_scanned_block_hash varchar(66),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id, token_address),
  FOREIGN KEY(chain_id, token_address)
    REFERENCES tokens(chain_id, token_address) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS token_holder_candidates (
  chain_id integer NOT NULL,
  token_address varchar(42) NOT NULL,
  wallet_address varchar(42) NOT NULL,
  first_seen_block bigint NOT NULL,
  last_seen_block bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id, token_address, wallet_address),
  FOREIGN KEY(chain_id, token_address)
    REFERENCES tokens(chain_id, token_address) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS token_holder_candidates_lookup_idx
  ON token_holder_candidates(chain_id, token_address, wallet_address);
DROP TRIGGER IF EXISTS token_holder_candidates_set_updated_at ON token_holder_candidates;
CREATE TRIGGER token_holder_candidates_set_updated_at BEFORE UPDATE ON token_holder_candidates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL,
  creator_address varchar(42) NOT NULL,
  token_address varchar(42) NOT NULL,
  token_name varchar(120) NOT NULL,
  token_symbol varchar(40) NOT NULL,
  token_decimals smallint NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  title varchar(180) NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL,
  metadata_hash varchar(66) NOT NULL,
  proposal_config numeric(78,0) NOT NULL,
  record_date_at timestamptz NOT NULL,
  record_date_block bigint,
  record_date_block_hash varchar(66),
  snapshot_root varchar(66),
  snapshot_holder_count integer,
  snapshot_total_balance numeric(78,0),
  token_to_vote_ratio bigint NOT NULL CHECK (token_to_vote_ratio > 0),
  vote_unit numeric(78,0) NOT NULL CHECK (vote_unit > 0),
  voting_start_at timestamptz NOT NULL,
  voting_end_at timestamptz NOT NULL,
  discovery_mode varchar(32) NOT NULL
    CHECK (discovery_mode IN ('PUBLIC_ELIGIBLE','SUBSCRIBERS_ONLY','DIRECT_LINK')),
  authenticity_claim varchar(32) NOT NULL
    CHECK (authenticity_claim IN ('COMMUNITY','ISSUER_AUTHORIZED')),
  authenticity_status varchar(32) NOT NULL
    CHECK (authenticity_status IN ('COMMUNITY','SELF_CLAIMED','TOKEN_OWNER_VERIFIED','PLATFORM_VERIFIED')),
  snap_delivery_mode varchar(32) NOT NULL
    CHECK (snap_delivery_mode IN ('DISABLED','ELIGIBLE','SUBSCRIBERS_ONLY')),
  status varchar(32) NOT NULL DEFAULT 'SNAPSHOT_PENDING'
    CHECK (status IN (
      'SNAPSHOT_PENDING','SNAPSHOT_RUNNING','SNAPSHOT_READY',
      'DEPLOYMENT_QUEUED','DEPLOYING','SCHEDULED','OPEN','CLOSED','FAILED'
    )),
  failure_reason text,
  contract_address varchar(42),
  deployment_tx_hash varchar(66),
  deployment_block bigint,
  deployment_block_hash varchar(66),
  source_verification_status varchar(24) NOT NULL DEFAULT 'NOT_SUBMITTED'
    CHECK (source_verification_status IN ('NOT_SUBMITTED','PENDING','VERIFIED','FAILED')),
  source_verification_url text,
  source_verification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (record_date_at <= voting_start_at),
  CHECK (voting_start_at < voting_end_at),
  FOREIGN KEY(chain_id, token_address) REFERENCES tokens(chain_id, token_address)
);
CREATE UNIQUE INDEX IF NOT EXISTS events_chain_contract_unique
  ON events(chain_id, contract_address) WHERE contract_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_creator_idx
  ON events(creator_address, created_at DESC);
CREATE INDEX IF NOT EXISTS events_discovery_idx
  ON events(discovery_mode, status, voting_end_at);
CREATE INDEX IF NOT EXISTS events_token_idx
  ON events(chain_id, token_address, created_at DESC);
DROP TRIGGER IF EXISTS events_set_updated_at ON events;
CREATE TRIGGER events_set_updated_at BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS snapshot_entries (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  wallet_address varchar(42) NOT NULL,
  raw_balance numeric(78,0) NOT NULL CHECK (raw_balance > 0),
  voting_power numeric(78,0) NOT NULL CHECK (voting_power > 0),
  leaf_index integer NOT NULL CHECK (leaf_index >= 0),
  leaf_hash varchar(66) NOT NULL,
  merkle_proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(event_id, wallet_address),
  UNIQUE(event_id, leaf_index)
);
CREATE INDEX IF NOT EXISTS snapshot_entries_wallet_idx
  ON snapshot_entries(wallet_address, event_id);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  voter_address varchar(42),
  job_type varchar(32) NOT NULL
    CHECK (job_type IN ('BUILD_SNAPSHOT','DEPLOY_EVENT','RELAY_VOTE','VERIFY_CONTRACT')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_message text,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS jobs_event_idx
  ON jobs(event_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_unique
  ON jobs(dedupe_key) WHERE status IN ('PENDING','RUNNING');
DROP TRIGGER IF EXISTS jobs_set_updated_at ON jobs;
CREATE TRIGGER jobs_set_updated_at BEFORE UPDATE ON jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  voter_address varchar(42) NOT NULL,
  snapshot_balance numeric(78,0) NOT NULL CHECK (snapshot_balance > 0),
  voting_power numeric(78,0) NOT NULL CHECK (voting_power > 0),
  choices jsonb NOT NULL,
  choices_hex text NOT NULL,
  voter_signature text NOT NULL,
  status varchar(20) NOT NULL
    CHECK (status IN ('QUEUED','SUBMITTED','CONFIRMED','FAILED')),
  transaction_hash varchar(66),
  block_number bigint,
  block_hash varchar(66),
  log_index integer,
  failure_message text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, voter_address)
);
CREATE UNIQUE INDEX IF NOT EXISTS votes_transaction_unique
  ON votes(transaction_hash) WHERE transaction_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS votes_event_status_idx
  ON votes(event_id, status);
DROP TRIGGER IF EXISTS votes_set_updated_at ON votes;
CREATE TRIGGER votes_set_updated_at BEFORE UPDATE ON votes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS event_index_state (
  event_id uuid PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  last_scanned_block bigint NOT NULL,
  last_scanned_block_hash varchar(66),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  creator_address varchar(42) NOT NULL,
  category varchar(32) NOT NULL
    CHECK (category IN (
      'EVENT_ANNOUNCEMENT','VOTING_OPEN','DEADLINE_REMINDER',
      'DOCUMENT_UPDATE','RESULTS_AVAILABLE','GENERAL'
    )),
  audience varchar(32) NOT NULL
    CHECK (audience IN ('ALL_ELIGIBLE','NOT_VOTED','SUBSCRIBERS')),
  title varchar(180) NOT NULL,
  body text NOT NULL,
  action_url text NOT NULL,
  published_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  signing_message text NOT NULL,
  creator_signature text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PUBLISHED'
    CHECK (status IN ('PUBLISHED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS communications_event_idx
  ON communications(event_id, published_at DESC);

CREATE TABLE IF NOT EXISTS snap_subscriptions (
  wallet_address varchar(42) NOT NULL,
  chain_id integer NOT NULL,
  token_address varchar(42) NOT NULL,
  categories text[] NOT NULL DEFAULT ARRAY[
    'EVENT_ANNOUNCEMENT','VOTING_OPEN','DEADLINE_REMINDER','RESULTS_AVAILABLE'
  ],
  status varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet_address, chain_id, token_address)
);
DROP TRIGGER IF EXISTS snap_subscriptions_set_updated_at ON snap_subscriptions;
CREATE TRIGGER snap_subscriptions_set_updated_at BEFORE UPDATE ON snap_subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS communication_deliveries (
  communication_id uuid NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
  wallet_address varchar(42) NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(communication_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  worker_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
