import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baiDiagnosticPromptCallIds, readBaiDiagnosticPromptSections, PROMPT_SECTION_LOOKUP_SQL }
  from '../src/agent-runtime/bai-diagnostic-reads.js';
import { projectBaiAttributionDiagnostics } from '../src/agent-runtime/bai-attribution-diagnostics.js';

test('bounded prompt details preserve all attribution totals and the requested historical call', () => {
  const now = Date.now();
  const ledgerRows = Array.from({ length: 151 }, (_, index) => ({ id: randomUUID(),
    created_at: new Date(now - (index === 0 ? 48 * 60 * 60_000 : (151 - index) * 1000)).toISOString(),
    provider_started_at: new Date(now - 1000).toISOString(), correlation_id: 'linked',
    status: 'succeeded', application_status: 'accepted', prompt_metrics_complete: true,
    request_bytes: 100, input_tokens: 100, output_tokens: 20,
    cost_source: 'usage_priced', effective_cost_nano_usd: '170000000' }));
  const sections = ledgerRows.flatMap((row) => ['system_protocol', 'memories'].map((name) => ({
    model_call_id: row.id, section_name: name, characters: 20, bytes: 20,
    estimated_tokens: 5, duplicate_bytes: 4, content_hash: 'hash' })));
  const requestedCallId = ledgerRows[0].id;
  const detailIds = new Set(baiDiagnosticPromptCallIds(ledgerRows, { now, requestedCallId }));
  assert.equal(detailIds.size, 13);
  assert.ok(detailIds.has(requestedCallId));
  const full = projectBaiAttributionDiagnostics({ ledgerRows, sectionRows: sections, now, requestedCallId });
  const bounded = projectBaiAttributionDiagnostics({ ledgerRows,
    sectionRows: sections.filter((row) => detailIds.has(row.model_call_id)), now, requestedCallId });
  assert.deepEqual(bounded, full);
  assert.equal(bounded.rolling24h.callsByValue.noEffectYet, 150);
  assert.equal(bounded.rolling24h.cost.knownCostUsd, 25.5);
  assert.equal(bounded.recentCalls.length, 12);
  assert.ok(bounded.call.promptEfficiency);
  assert.equal(baiDiagnosticPromptCallIds(ledgerRows, { now }).length, 12);
});

test('diagnostic reads retain all calls and sections while bounding and deduplicating each lookup', async () => {
  const ids = Array.from({ length: 151 }, () => randomUUID());
  const queries = [];
  const client = { async query(_sql, [batch]) {
    queries.push(batch);
    return { rows: batch.flatMap((model_call_id) => ['world', 'rules'].map((section_name) =>
      ({ model_call_id, section_name, bytes: 10 }))) };
  } };
  const result = await readBaiDiagnosticPromptSections(client, [...ids, ids[0]], { batchSize: 32 });
  assert.equal(result.batches, 5);
  assert.ok(queries.every((q) => q.length <= 32));
  assert.equal(result.rows.length, 302);
  assert.equal(new Set(result.rows.map((r) => r.model_call_id)).size, 151);
  assert.equal((await readBaiDiagnosticPromptSections(client, [])).batches, 0);
  await assert.rejects(readBaiDiagnosticPromptSections(client, ['invalid']), TypeError);
  await assert.rejects(readBaiDiagnosticPromptSections(client, ids, { batchSize: 0 }), TypeError);
});

const url = process.env.RUNTIME_OBSERVABILITY_TEST_DATABASE_URL;
test('PostgreSQL reads the complete prompt-section set through indexed lateral lookups', {
  skip: !url, timeout: 10_000
}, async () => {
  const target = new URL(url);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(target.hostname));
  assert.notEqual(target.port, '5432');
  assert.ok(target.pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 1,
    options: '-c search_path=diagnostic_read_test,public -c statement_timeout=3000' });
  try {
    await pool.query('CREATE SCHEMA diagnostic_read_test');
    await pool.query(`CREATE TABLE bai_model_prompt_sections(model_call_id uuid NOT NULL,section_name text NOT NULL,
      characters bigint,bytes bigint,estimated_tokens bigint,content_hash text,duplicate_hash text,
      duplicate_bytes bigint, PRIMARY KEY(model_call_id,section_name))`);
    const ids = Array.from({ length: 700 }, () => randomUUID());
    await pool.query(`INSERT INTO bai_model_prompt_sections
      SELECT id,'section-'||n,100,100,25,NULL,NULL,0
      FROM unnest($1::uuid[]) ids(id) CROSS JOIN generate_series(1,8) n`, [ids]);
    await pool.query('ANALYZE bai_model_prompt_sections');
    const rows = await readBaiDiagnosticPromptSections(pool, ids);
    assert.equal(rows.batches, 11);
    assert.equal(rows.rows.length, 5600, 'no truncation to the most recent calls');
    const plan = (await pool.query('EXPLAIN (FORMAT JSON) ' + PROMPT_SECTION_LOOKUP_SQL, [ids.slice(0,64)]))
      .rows[0]['QUERY PLAN'][0].Plan;
    const scans = [];
    function walk(node) {
      if (node['Relation Name'] === 'bai_model_prompt_sections') scans.push(node);
      for (const child of node.Plans || []) walk(child);
    }
    walk(plan);
    assert.ok(scans.length > 0);
    assert.ok(scans.every((n) => n['Node Type'] !== 'Seq Scan'), 'no full prompt-section table scan');
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS diagnostic_read_test CASCADE');
    await pool.end();
  }
});
