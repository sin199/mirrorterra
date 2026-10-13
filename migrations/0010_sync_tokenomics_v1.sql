-- SYNC Tokenomics v1.0 state and the append-only, double-entry Operating Pool bridge.

ALTER TABLE arc_token_issuance_intents
  ADD COLUMN superseded_reason text,
  ADD COLUMN superseded_from_status text,
  ADD COLUMN superseded_world_minute bigint;

ALTER TABLE arc_token_issuance_intents DROP CONSTRAINT IF EXISTS arc_token_issuance_intents_status_check;
ALTER TABLE arc_token_issuance_intents ADD CONSTRAINT arc_token_issuance_intents_status_check
  CHECK (status = ANY (ARRAY['incomplete'::text,'proposed'::text,'issuer_confirmed'::text,'deferred'::text,
    'deferred_until_multi_asset_capability'::text,'budget_blocked'::text,'preparing'::text,'prepared'::text,
    'submitting'::text,'submission_unknown'::text,'submitted'::text,'created'::text,'rejected'::text,
    'failed'::text,'extension_requested'::text,'superseded'::text]));
ALTER TABLE arc_token_issuance_intents ADD CONSTRAINT arc_token_issuance_intents_superseded_fields_check
  CHECK ((status='superseded' AND superseded_reason IS NOT NULL AND char_length(superseded_reason) BETWEEN 1 AND 160
      AND superseded_from_status IS NOT NULL AND superseded_from_status <> 'superseded'
      AND superseded_world_minute IS NOT NULL AND superseded_world_minute >= created_world_minute)
    OR (status<>'superseded' AND superseded_reason IS NULL AND superseded_from_status IS NULL
      AND superseded_world_minute IS NULL));
ALTER TABLE arc_token_issuance_intents ADD CONSTRAINT arc_token_issuance_intents_superseded_minute_check
  CHECK (superseded_world_minute IS NULL OR superseded_world_minute >= 0);

ALTER TABLE arc_agent_tokens DROP CONSTRAINT IF EXISTS arc_agent_tokens_unallocated_supply_handling_check;
ALTER TABLE arc_agent_tokens ADD CONSTRAINT arc_agent_tokens_unallocated_supply_handling_check
  CHECK (unallocated_supply_handling = ANY (ARRAY['fully_distributed'::text,'issuer_controlled_reserve'::text,
    'locked_reserve'::text,'protocol_managed_reserve'::text]));
ALTER TABLE arc_agent_tokens DROP CONSTRAINT IF EXISTS arc_agent_tokens_authority_model_check;
ALTER TABLE arc_agent_tokens ADD CONSTRAINT arc_agent_tokens_authority_model_check
  CHECK (authority_model = ANY (ARRAY['no_mint_no_burn'::text,'issuer_controlled_reserve'::text,
    'locked_reserve'::text,'immutable_protocol_rules'::text]));

-- The payout amount is an explicit raw SYNC amount from a formal economic action.
-- It is never calculated from that action's USDC amount.
ALTER TABLE world_economic_transactions ADD COLUMN sync_payout_raw numeric(78,0);
ALTER TABLE world_economic_transactions ADD CONSTRAINT world_economic_transactions_sync_payout_raw_check
  CHECK (sync_payout_raw IS NULL OR sync_payout_raw > 0);

ALTER TABLE arc_infrastructure_nonce_reservations DROP CONSTRAINT IF EXISTS arc_infrastructure_nonce_reservations_operation_type_check;
ALTER TABLE arc_infrastructure_nonce_reservations ADD CONSTRAINT arc_infrastructure_nonce_reservations_operation_type_check
  CHECK (operation_type IN ('token_creation','token_reserve_release','deployment','checkpoint','provenance',
    'operating_pool_payout'));

CREATE FUNCTION prevent_world_economic_sync_payout_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sync_payout_raw IS DISTINCT FROM NEW.sync_payout_raw THEN
    RAISE EXCEPTION 'formal economic action SYNC payout amount is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_economic_sync_payout_immutable
  BEFORE UPDATE OF sync_payout_raw ON world_economic_transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_world_economic_sync_payout_rewrite();

CREATE TABLE arc_sync_tokenomics_deployments (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE RESTRICT,
  chain_id integer NOT NULL CHECK (chain_id=5042),
  manifest_hash text NOT NULL CHECK (manifest_hash='0x01f5b27328f71c465660cc59394d72d19c473b3d3b85c4ef60bbed7d23cc7596'),
  issuer_agent_id uuid NOT NULL,
  issuer_wallet text NOT NULL CHECK (issuer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-fA-F]{40}$'),
  reserve_address text NOT NULL CHECK (reserve_address ~ '^0x[0-9a-fA-F]{40}$'),
  operating_pool_address text NOT NULL CHECK (operating_pool_address ~ '^0x[0-9a-fA-F]{40}$'),
  auction_address text NOT NULL CHECK (auction_address ~ '^0x[0-9a-fA-F]{40}$'),
  market_pool_address text NOT NULL CHECK (market_pool_address ~ '^0x[0-9a-fA-F]{40}$'),
  genesis_policy_address text NOT NULL CHECK (genesis_policy_address ~ '^0x[0-9a-fA-F]{40}$'),
  settlement_worker_address text NOT NULL CHECK (settlement_worker_address ~ '^0x[0-9a-fA-F]{40}$'),
  deployment_transaction_hash text NOT NULL CHECK (deployment_transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  deployment_block numeric(78,0) NOT NULL CHECK (deployment_block>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,issuer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  UNIQUE (chain_id,token_address),
  UNIQUE (chain_id,deployment_transaction_hash)
);

CREATE FUNCTION enforce_arc_sync_deployment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM worlds WHERE id=NEW.world_id AND chain_id=5042)
      OR NOT EXISTS (SELECT 1 FROM arc_agent_wallets wallet
        WHERE wallet.world_id=NEW.world_id AND wallet.agent_id=NEW.issuer_agent_id AND wallet.chain_id=5042
          AND wallet.status='active' AND lower(wallet.address)=lower(NEW.issuer_wallet)) THEN
    RAISE EXCEPTION 'SYNC deployment must match the active Arc Mainnet issuer wallet';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_deployment_identity_check
  BEFORE INSERT ON arc_sync_tokenomics_deployments
  FOR EACH ROW EXECUTE FUNCTION enforce_arc_sync_deployment_identity();

CREATE FUNCTION prevent_arc_sync_deployment_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SYNC tokenomics deployment record is immutable';
END $$;
CREATE TRIGGER arc_sync_deployment_immutable
  BEFORE UPDATE OR DELETE ON arc_sync_tokenomics_deployments
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_deployment_rewrite();

CREATE TABLE arc_sync_ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  account_type text NOT NULL CHECK (account_type IN ('operating_pool','agent')),
  account_key text NOT NULL CHECK (char_length(account_key) BETWEEN 1 AND 180),
  agent_id uuid,
  opening_balance_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (opening_balance_raw>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arc_sync_ledger_accounts_world_account_key UNIQUE (world_id,account_key),
  CONSTRAINT arc_sync_ledger_accounts_world_id_id_key UNIQUE (world_id,id),
  CONSTRAINT arc_sync_ledger_accounts_world_agent_fkey FOREIGN KEY (world_id,agent_id)
    REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  CONSTRAINT arc_sync_ledger_accounts_owner_shape_check CHECK (
    (account_type='operating_pool' AND account_key='operating-pool' AND agent_id IS NULL
      AND opening_balance_raw=10000000000000)
    OR (account_type='agent' AND agent_id IS NOT NULL AND account_key='agent:'||agent_id::text
      AND opening_balance_raw=0))
);

CREATE FUNCTION seed_arc_sync_operating_pool_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO arc_sync_ledger_accounts(world_id,account_type,account_key,agent_id,opening_balance_raw)
  VALUES(NEW.world_id,'operating_pool','operating-pool',NULL,10000000000000);
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_operating_pool_account_seed
  AFTER INSERT ON arc_sync_tokenomics_deployments
  FOR EACH ROW EXECUTE FUNCTION seed_arc_sync_operating_pool_account();

CREATE TABLE arc_sync_ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  source_economic_action_id text NOT NULL CHECK (char_length(source_economic_action_id) BETWEEN 1 AND 180),
  transaction_type text NOT NULL CHECK (transaction_type='operating_pool_payout'),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','committed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  CONSTRAINT arc_sync_ledger_transactions_world_id_id_key UNIQUE (world_id,id),
  CONSTRAINT arc_sync_ledger_transactions_world_action_key UNIQUE (world_id,action_id),
  CONSTRAINT arc_sync_ledger_transactions_source_action_key UNIQUE (world_id,source_economic_action_id),
  CONSTRAINT arc_sync_ledger_transactions_source_action_fkey FOREIGN KEY (world_id,source_economic_action_id)
    REFERENCES world_economic_transactions(world_id,action_id) ON DELETE RESTRICT,
  CONSTRAINT arc_sync_ledger_transactions_committed_at_check CHECK (
    (status='committed' AND committed_at IS NOT NULL) OR (status='draft' AND committed_at IS NULL))
);

CREATE TABLE arc_sync_ledger_postings (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw<>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arc_sync_ledger_postings_transaction_account_key UNIQUE (transaction_id,account_id),
  CONSTRAINT arc_sync_ledger_postings_world_transaction_fkey FOREIGN KEY (world_id,transaction_id)
    REFERENCES arc_sync_ledger_transactions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT arc_sync_ledger_postings_world_account_fkey FOREIGN KEY (world_id,account_id)
    REFERENCES arc_sync_ledger_accounts(world_id,id) ON DELETE RESTRICT
);
CREATE INDEX arc_sync_ledger_postings_account_idx ON arc_sync_ledger_postings(world_id,account_id,transaction_id);

CREATE TABLE arc_sync_payout_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  agent_id uuid NOT NULL,
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw>0),
  status text NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','submitting','submission_unknown',
    'submitted','reconciled','failed')),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_sender text CHECK (transaction_sender IS NULL OR transaction_sender ~ '^0x[0-9a-fA-F]{40}$'),
  transaction_nonce numeric(78,0) CHECK (transaction_nonce IS NULL OR transaction_nonce>=0),
  gas_limit numeric(78,0) CHECK (gas_limit IS NULL OR gas_limit>0),
  max_fee_per_gas numeric(78,0) CHECK (max_fee_per_gas IS NULL OR max_fee_per_gas>0),
  start_block numeric(78,0) CHECK (start_block IS NULL OR start_block>=0),
  block_number numeric(78,0) CHECK (block_number IS NULL OR block_number>=0),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,120}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arc_sync_payout_outbox_transaction_key UNIQUE (transaction_id),
  CONSTRAINT arc_sync_payout_outbox_world_action_key UNIQUE (world_id,action_id),
  CONSTRAINT arc_sync_payout_outbox_world_transaction_fkey FOREIGN KEY (world_id,transaction_id)
    REFERENCES arc_sync_ledger_transactions(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT arc_sync_payout_outbox_world_agent_fkey FOREIGN KEY (world_id,agent_id)
    REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  CONSTRAINT arc_sync_payout_outbox_submission_evidence_check CHECK (
    status NOT IN ('submitted','reconciled') OR transaction_hash IS NOT NULL)
);
CREATE INDEX arc_sync_payout_outbox_ready_idx ON arc_sync_payout_outbox(world_id,created_at,id)
  WHERE status='committed';

CREATE FUNCTION enforce_arc_sync_draft_postings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transaction_status text;
BEGIN
  SELECT status INTO transaction_status FROM arc_sync_ledger_transactions
    WHERE world_id=COALESCE(NEW.world_id,OLD.world_id) AND id=COALESCE(NEW.transaction_id,OLD.transaction_id)
    FOR UPDATE;
  IF transaction_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SYNC ledger postings are immutable after commit';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_postings_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON arc_sync_ledger_postings
  FOR EACH ROW EXECUTE FUNCTION enforce_arc_sync_draft_postings();

CREATE FUNCTION enforce_arc_sync_ledger_transaction_commit_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'SYNC ledger transactions are append-only';
  END IF;
  IF OLD.status<>'draft' OR NEW.status<>'committed' OR NEW.committed_at IS NULL
      OR (NEW.id,NEW.world_id,NEW.action_id,NEW.source_economic_action_id,NEW.transaction_type,
          NEW.world_minute,NEW.metadata,NEW.created_at)
        IS DISTINCT FROM
         (OLD.id,OLD.world_id,OLD.action_id,OLD.source_economic_action_id,OLD.transaction_type,
          OLD.world_minute,OLD.metadata,OLD.created_at) THEN
    RAISE EXCEPTION 'SYNC ledger transactions allow only one immutable draft-to-committed transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_ledger_transaction_commit_only
  BEFORE UPDATE OR DELETE ON arc_sync_ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION enforce_arc_sync_ledger_transaction_commit_only();

CREATE FUNCTION prevent_arc_sync_ledger_account_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SYNC ledger accounts are immutable';
END $$;
CREATE TRIGGER arc_sync_ledger_accounts_immutable
  BEFORE UPDATE OR DELETE ON arc_sync_ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_ledger_account_rewrite();

CREATE FUNCTION enforce_arc_sync_outbox_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.world_id,NEW.transaction_id,NEW.action_id,NEW.agent_id,NEW.recipient_address,NEW.amount_raw)
        IS DISTINCT FROM
       (OLD.world_id,OLD.transaction_id,OLD.action_id,OLD.agent_id,OLD.recipient_address,OLD.amount_raw)
        OR OLD.status IN ('reconciled','failed') THEN
      RAISE EXCEPTION 'SYNC payout identity and terminal outbox rows are immutable';
    END IF;
    IF NOT ((OLD.status='committed' AND NEW.status='submitting')
        OR (OLD.status='submitting' AND NEW.status IN ('submission_unknown','submitted','failed'))
        OR (OLD.status='submission_unknown' AND NEW.status IN ('submitted','reconciled','failed'))
        OR (OLD.status='submitted' AND NEW.status IN ('reconciled','failed'))) THEN
      RAISE EXCEPTION 'invalid SYNC payout outbox state transition';
    END IF;
    IF OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN
      RAISE EXCEPTION 'SYNC payout transaction hash is immutable once recorded';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_outbox_state_transition
  BEFORE UPDATE ON arc_sync_payout_outbox
  FOR EACH ROW EXECUTE FUNCTION enforce_arc_sync_outbox_transition();

CREATE FUNCTION enforce_arc_sync_committed_double_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_count integer;
  posting_sum numeric;
  payout arc_sync_payout_outbox%ROWTYPE;
  pool_debits integer;
  recipient_credits integer;
  current_balance numeric;
BEGIN
  IF NEW.status<>'committed' THEN RETURN NEW; END IF;
  SELECT * INTO payout FROM arc_sync_payout_outbox
    WHERE world_id=NEW.world_id AND transaction_id=NEW.id AND action_id=NEW.action_id;
  IF NOT FOUND OR payout.status<>'committed' THEN
    RAISE EXCEPTION 'committed SYNC payout requires its matching committed outbox';
  END IF;
  SELECT count(*)::integer,COALESCE(sum(posting.amount_raw),0),
      count(*) FILTER (WHERE account.account_type='operating_pool' AND posting.amount_raw=-payout.amount_raw)::integer,
      count(*) FILTER (WHERE account.account_type='agent' AND account.agent_id=payout.agent_id
        AND posting.amount_raw=payout.amount_raw)::integer
    INTO entry_count,posting_sum,pool_debits,recipient_credits
    FROM arc_sync_ledger_postings posting JOIN arc_sync_ledger_accounts account
      ON account.world_id=posting.world_id AND account.id=posting.account_id
    WHERE posting.world_id=NEW.world_id AND posting.transaction_id=NEW.id;
  IF entry_count<>2 OR posting_sum<>0 OR pool_debits<>1 OR recipient_credits<>1 THEN
    RAISE EXCEPTION 'SYNC payout needs one exact Operating Pool debit and one matching Agent credit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM world_economic_transactions economic
      JOIN world_economic_accounts destination ON destination.world_id=economic.world_id
        AND destination.id=economic.destination_account_id
      JOIN arc_agent_wallets wallet ON wallet.world_id=economic.world_id
        AND wallet.agent_id=destination.owner_id AND wallet.chain_id=5042 AND wallet.status='active'
      WHERE economic.world_id=NEW.world_id AND economic.action_id=NEW.source_economic_action_id
        AND economic.sync_payout_raw=payout.amount_raw AND destination.account_type='resident'
        AND destination.owner_id=payout.agent_id AND lower(wallet.address)=lower(payout.recipient_address)) THEN
    RAISE EXCEPTION 'SYNC payout does not match a formal economic action and active Agent wallet';
  END IF;
  SELECT account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0) INTO current_balance
    FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
      ON posting.world_id=account.world_id AND posting.account_id=account.id
    WHERE account.world_id=NEW.world_id AND account.account_type='operating_pool'
    GROUP BY account.id,account.opening_balance_raw;
  IF current_balance IS NULL OR current_balance<0 THEN
    RAISE EXCEPTION 'SYNC Operating Pool ledger balance cannot be negative';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER arc_sync_ledger_committed_double_entry_check
  AFTER INSERT OR UPDATE ON arc_sync_ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_arc_sync_committed_double_entry();

-- Deployment records are written by a privileged deployment reconciler only.
-- The World Engine and payout worker can read, but cannot forge, deployment state.
GRANT SELECT ON arc_sync_tokenomics_deployments TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_ledger_accounts TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_ledger_transactions TO synterra_app;
GRANT UPDATE(status,committed_at) ON arc_sync_ledger_transactions TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_ledger_postings TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE arc_sync_ledger_postings_id_seq TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_payout_outbox TO synterra_app;
GRANT UPDATE(status,transaction_hash,transaction_sender,transaction_nonce,gas_limit,max_fee_per_gas,
  start_block,block_number,failure_code,updated_at) ON arc_sync_payout_outbox TO synterra_app;
