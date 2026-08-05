ALTER TABLE communications
  ALTER COLUMN event_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS scope varchar(12) NOT NULL DEFAULT 'EVENT',
  ADD COLUMN IF NOT EXISTS chain_id integer,
  ADD COLUMN IF NOT EXISTS token_address varchar(42),
  ADD COLUMN IF NOT EXISTS token_name varchar(120),
  ADD COLUMN IF NOT EXISTS token_symbol varchar(40),
  ADD COLUMN IF NOT EXISTS creator_address varchar(42),
  ADD COLUMN IF NOT EXISTS authenticity_status varchar(24);

ALTER TABLE communications DROP CONSTRAINT IF EXISTS communications_scope_check;
ALTER TABLE communications DROP CONSTRAINT IF EXISTS communications_chain_id_check;
ALTER TABLE communications DROP CONSTRAINT IF EXISTS communications_authenticity_status_check;
ALTER TABLE communications DROP CONSTRAINT IF EXISTS communications_audience_check;

ALTER TABLE communications
  ADD CONSTRAINT communications_scope_value_check CHECK (scope IN ('EVENT','TOKEN')),
  ADD CONSTRAINT communications_chain_id_check CHECK (chain_id IS NULL OR chain_id = 80002),
  ADD CONSTRAINT communications_authenticity_status_check CHECK (
    authenticity_status IS NULL OR authenticity_status IN ('COMMUNITY','SELF_CLAIMED','TOKEN_OWNER_VERIFIED')
  ),
  ADD CONSTRAINT communications_audience_check CHECK (
    audience IN ('ALL_ELIGIBLE','NOT_VOTED','SUBSCRIBERS','CURRENT_HOLDERS')
  ),
  ADD CONSTRAINT communications_scope_check CHECK (
    (scope = 'EVENT' AND event_id IS NOT NULL)
    OR
    (scope = 'TOKEN' AND event_id IS NULL AND chain_id IS NOT NULL AND token_address IS NOT NULL
      AND token_name IS NOT NULL AND token_symbol IS NOT NULL AND creator_address IS NOT NULL
      AND authenticity_status IS NOT NULL)
  );

DROP INDEX IF EXISTS communications_event_idx;
CREATE INDEX communications_event_idx
  ON communications(event_id, published_at DESC)
  WHERE scope='EVENT';
CREATE INDEX IF NOT EXISTS communications_token_idx
  ON communications(token_address, published_at DESC)
  WHERE scope='TOKEN';
