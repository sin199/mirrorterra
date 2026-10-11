DO $$
DECLARE
  target_world CONSTANT uuid := 'ce434421-8bcd-4aac-b9ba-183383c713de';
  matched_members integer;
BEGIN
  IF EXISTS (SELECT 1 FROM worlds WHERE id=target_world) THEN
    IF NOT EXISTS (
      SELECT 1 FROM worlds
      WHERE id=target_world AND name IN ('Synterra','MirrorTerra')
    ) THEN
      RAISE EXCEPTION 'MirrorTerra brand migration found an unexpected existing world name';
    END IF;

  WITH expected(agent_id, slot) AS (VALUES
    ('f952ef0a-001f-408e-8e5d-684b63f133ac'::uuid,'01'),
    ('3b331e3d-88c9-4080-adf1-0fedc13b52ae'::uuid,'02'),
    ('57c09d40-df32-4293-af2f-653b85c6244a'::uuid,'03'),
    ('559191b8-b469-46ad-962e-b0627cb8e8db'::uuid,'04'),
    ('f667acff-2c2e-4481-b732-e3fbea562013'::uuid,'05'),
    ('745df3f0-e36e-4350-827d-cb945b872b71'::uuid,'06'),
    ('f29f61e4-9757-4b1c-a1b8-2da4fca62bae'::uuid,'07'),
    ('012fdab2-73a6-4655-9aba-f29c1892a84e'::uuid,'08'),
    ('3cd80db6-ad3d-41a0-bb62-04c4e5720cd8'::uuid,'09'),
    ('46015f3f-d58c-4e0f-8bd6-bdb2afc3da91'::uuid,'10')
  )
  SELECT count(*)::integer INTO matched_members
  FROM expected
  JOIN world_members member ON member.world_id=target_world AND member.agent_id=expected.agent_id
  JOIN agents agent ON agent.id=expected.agent_id
  WHERE agent.name IN ('Synterra-'||expected.slot,'MirrorTerra-'||expected.slot);

  IF matched_members <> 10 THEN
    RAISE EXCEPTION 'MirrorTerra brand migration requires the same ten verified Agent identities';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agents existing
    JOIN world_members member ON member.world_id=target_world AND member.agent_id=existing.id
    WHERE existing.name LIKE 'MirrorTerra-%'
      AND existing.id NOT IN (
        'f952ef0a-001f-408e-8e5d-684b63f133ac','3b331e3d-88c9-4080-adf1-0fedc13b52ae',
        '57c09d40-df32-4293-af2f-653b85c6244a','559191b8-b469-46ad-962e-b0627cb8e8db',
        'f667acff-2c2e-4481-b732-e3fbea562013','745df3f0-e36e-4350-827d-cb945b872b71',
        'f29f61e4-9757-4b1c-a1b8-2da4fca62bae','012fdab2-73a6-4655-9aba-f29c1892a84e',
        '3cd80db6-ad3d-41a0-bb62-04c4e5720cd8','46015f3f-d58c-4e0f-8bd6-bdb2afc3da91'
      )
  ) THEN
    RAISE EXCEPTION 'MirrorTerra Agent display-name collision detected';
  END IF;

  UPDATE worlds SET name='MirrorTerra' WHERE id=target_world AND name='Synterra';

  WITH expected(agent_id, slot) AS (VALUES
    ('f952ef0a-001f-408e-8e5d-684b63f133ac'::uuid,'01'),
    ('3b331e3d-88c9-4080-adf1-0fedc13b52ae'::uuid,'02'),
    ('57c09d40-df32-4293-af2f-653b85c6244a'::uuid,'03'),
    ('559191b8-b469-46ad-962e-b0627cb8e8db'::uuid,'04'),
    ('f667acff-2c2e-4481-b732-e3fbea562013'::uuid,'05'),
    ('745df3f0-e36e-4350-827d-cb945b872b71'::uuid,'06'),
    ('f29f61e4-9757-4b1c-a1b8-2da4fca62bae'::uuid,'07'),
    ('012fdab2-73a6-4655-9aba-f29c1892a84e'::uuid,'08'),
    ('3cd80db6-ad3d-41a0-bb62-04c4e5720cd8'::uuid,'09'),
    ('46015f3f-d58c-4e0f-8bd6-bdb2afc3da91'::uuid,'10')
  )
  UPDATE agents agent SET name='MirrorTerra-'||expected.slot
  FROM expected
  JOIN world_members member ON member.world_id=target_world AND member.agent_id=expected.agent_id
  WHERE agent.id=expected.agent_id AND agent.name='Synterra-'||expected.slot;
  END IF;
END $$;
