import { rollingBaiAttributionCalls } from './bai-attribution-diagnostics.js';

// The report exposes prompt sections only for recentCalls (12), the latest call,
// and an explicitly requested older call. All ledger/effect rows still feed the
// complete 24-hour totals; fetching sections for other calls changes no output.
export function baiDiagnosticPromptCallIds(ledgerRows, { now = Date.now(), requestedCallId = null } = {}) {
  const recent = rollingBaiAttributionCalls(ledgerRows, now).slice(-12);
  const requested = requestedCallId && ledgerRows.find((row) => row.id === requestedCallId);
  return [...new Set([...recent, ...(requested ? [requested] : [])]
    .filter((row) => row.provider_started_at).map((row) => row.id))];
}

// A large ANY(uuid[]) let the planner scan the whole prompt-section table in
// production. A small batch and a non-flattenable lateral lookup bound each read
// to the existing (model_call_id, section_name) primary key without losing rows.
export const PROMPT_SECTION_LOOKUP_SQL = `SELECT section.*
  FROM unnest($1::uuid[]) requested(model_call_id)
  CROSS JOIN LATERAL (
    SELECT model_call_id,section_name,characters,bytes,estimated_tokens,
      content_hash,duplicate_hash,duplicate_bytes
    FROM bai_model_prompt_sections WHERE model_call_id=requested.model_call_id
    ORDER BY section_name OFFSET 0
  ) section ORDER BY section.model_call_id,section.section_name`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function readBaiDiagnosticPromptSections(client, callIds, { batchSize = 64 } = {}) {
  if (!Array.isArray(callIds) || callIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    throw new TypeError('INVALID_DIAGNOSTIC_CALL_IDS');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new TypeError('INVALID_DIAGNOSTIC_BATCH_SIZE');
  }
  const ids = [...new Set(callIds)];
  const rows = [];
  let batches = 0;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const result = await client.query(PROMPT_SECTION_LOOKUP_SQL, [ids.slice(offset, offset + batchSize)]);
    rows.push(...result.rows);
    batches += 1;
  }
  rows.sort((a, b) => a.model_call_id < b.model_call_id ? -1 : a.model_call_id > b.model_call_id ? 1
    : a.section_name < b.section_name ? -1 : a.section_name > b.section_name ? 1 : 0);
  return { rows, batches };
}
