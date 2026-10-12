-- Turnkey owns Agent signing keys. MirrorTerra persists public identifiers only.
ALTER TABLE arc_agent_wallets
  ADD COLUMN IF NOT EXISTS provider_suborganization_id text,
  ADD COLUMN IF NOT EXISTS provider_wallet_id text,
  ADD COLUMN IF NOT EXISTS provider_key_reference text,
  ADD COLUMN IF NOT EXISTS provisioning_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='arc_agent_wallets'::regclass
      AND conname='arc_agent_wallets_provider_check') THEN
    ALTER TABLE arc_agent_wallets ADD CONSTRAINT arc_agent_wallets_provider_check
      CHECK (provider = ANY (ARRAY['managed_wallet'::text, 'external_kms'::text, 'turnkey'::text]));
  ELSE
    ALTER TABLE arc_agent_wallets DROP CONSTRAINT arc_agent_wallets_provider_check;
    ALTER TABLE arc_agent_wallets ADD CONSTRAINT arc_agent_wallets_provider_check
      CHECK (provider = ANY (ARRAY['managed_wallet'::text, 'external_kms'::text, 'turnkey'::text]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='arc_agent_wallets'::regclass
      AND conname='arc_agent_wallets_provisioning_provenance_check') THEN
    ALTER TABLE arc_agent_wallets ADD CONSTRAINT arc_agent_wallets_provisioning_provenance_check
      CHECK (jsonb_typeof(provisioning_provenance) = 'object'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='arc_agent_wallets'::regclass
      AND conname='arc_agent_wallets_turnkey_references_check') THEN
    ALTER TABLE arc_agent_wallets ADD CONSTRAINT arc_agent_wallets_turnkey_references_check
      CHECK (provider <> 'turnkey'::text OR (
        NULLIF(btrim(provider_suborganization_id), ''::text) IS NOT NULL
        AND NULLIF(btrim(provider_wallet_id), ''::text) IS NOT NULL
        AND NULLIF(btrim(provider_key_reference), ''::text) IS NOT NULL
        AND provisioning_provenance->>'source' = 'operator_approved_genesis_agent_provisioning'::text
      ));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS arc_agent_wallets_turnkey_suborganization_key
  ON arc_agent_wallets(provider_suborganization_id)
  WHERE provider = 'turnkey'::text AND provider_suborganization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS arc_agent_wallets_turnkey_wallet_key
  ON arc_agent_wallets(provider_wallet_id)
  WHERE provider = 'turnkey'::text AND provider_wallet_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS arc_agent_wallets_turnkey_key_reference_key
  ON arc_agent_wallets(provider_key_reference)
  WHERE provider = 'turnkey'::text AND provider_key_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS arc_agent_wallets_turnkey_world_address_key
  ON arc_agent_wallets(world_id,chain_id,lower(address))
  WHERE provider = 'turnkey'::text;

-- Durable create state makes a lost Turnkey response recoverable without
-- silently issuing a second remote identity.
CREATE TABLE IF NOT EXISTS arc_turnkey_agent_wallet_provisioning (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  suborganization_name text NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY[
    'requested'::text, 'create_started'::text, 'create_unknown'::text, 'provisioned'::text
  ])),
  provider_suborganization_id text,
  provider_wallet_id text,
  provider_key_reference text,
  address text CHECK (address IS NULL OR address ~ '^0x[0-9a-fA-F]{40}$'::text),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,80}$'::text),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'::text),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arc_turnkey_agent_wallet_provisioning_pkey PRIMARY KEY (world_id,agent_id),
  CONSTRAINT arc_turnkey_agent_wallet_provisioning_world_id_agent_id_fkey
    FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  CONSTRAINT arc_turnkey_agent_wallet_provisioning_suborganization_name_key UNIQUE (suborganization_name),
  CONSTRAINT arc_turnkey_agent_wallet_provisioning_suborganization_id_key UNIQUE (provider_suborganization_id),
  CONSTRAINT arc_turnkey_agent_wallet_provisioning_wallet_id_key UNIQUE (provider_wallet_id),
  CONSTRAINT arc_turnkey_agent_wallet_provisioning_key_reference_key UNIQUE (provider_key_reference),
  CONSTRAINT arc_turnkey_agent_wallet_provisioning_provisioned_refs_check
    CHECK (status <> 'provisioned'::text OR (
      provider_suborganization_id IS NOT NULL AND provider_wallet_id IS NOT NULL
      AND provider_key_reference IS NOT NULL AND address IS NOT NULL
    ))
);
CREATE UNIQUE INDEX IF NOT EXISTS arc_turnkey_agent_wallet_provisioning_address_key
  ON arc_turnkey_agent_wallet_provisioning(lower(address))
  WHERE address IS NOT NULL;
