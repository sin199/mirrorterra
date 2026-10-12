-- Preserve verified external pilot funding separately from token distribution,
-- Agent income, and issuance costs. The runtime role does not receive access.
CREATE TABLE IF NOT EXISTS arc_mainnet_pilot_funding_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id = 5042),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  category text NOT NULL CHECK (category = 'genesis_bootstrap_gas_funding'),
  asset_symbol text NOT NULL DEFAULT 'USDC' CHECK (asset_symbol = 'USDC'),
  receipt_emitter_address text NOT NULL CHECK (receipt_emitter_address ~ '^0x[0-9a-fA-F]{40}$'),
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
  receipt_amount_raw numeric(78,0) NOT NULL CHECK (receipt_amount_raw > 0),
  receipt_asset_decimals smallint NOT NULL CHECK (receipt_asset_decimals BETWEEN 0 AND 36),
  budget_amount_usdc_base_units numeric(78,0) NOT NULL,
  receipt_block_number numeric(78,0) NOT NULL CHECK (receipt_block_number >= 0),
  receipt_timestamp timestamptz NOT NULL,
  CONSTRAINT arc_mpfl_budget_amount_check CHECK (budget_amount_usdc_base_units > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arc_mainnet_pilot_funding_ledger_world_fkey
    FOREIGN KEY (world_id) REFERENCES worlds(id) ON DELETE RESTRICT,
  CONSTRAINT arc_mainnet_pilot_funding_ledger_world_agent_fkey
    FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  CONSTRAINT arc_mainnet_pilot_funding_ledger_chain_transaction_key UNIQUE (chain_id,transaction_hash)
);
