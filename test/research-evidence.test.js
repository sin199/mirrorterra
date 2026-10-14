import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildEvidenceExportArgs, isExplicitResourceConstraint,
  MAX_REA_EXPORTED_EVIDENCE_BYTES, validateEvidenceExportBytes } from '../src/research/rea-evidence.js';

const destination = path.resolve('/tmp/rea-evidence-fixture.json');
const exportSchema = { type: 'object', properties: {
  output_path: { type: 'string' }, overwrite: { type: 'boolean' }
}, required: ['output_path', 'overwrite'] };

function fixture({ records = [{ id: 'record-1', findings: [{ summary: 'Fixture evidence' }] }], unknowns = [] } = {}) {
  const bytes = Buffer.from(JSON.stringify({ records, unknowns }));
  return { bytes, summary: { path: destination, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), records: records.length, unknowns: unknowns.length } };
}

test('resource_constraint requires an exact status or error code and export uses the declared output path', () => {
  assert.equal(isExplicitResourceConstraint({ structuredContent: { status: 'resource_constraint', retryable: false } }), true);
  assert.equal(isExplicitResourceConstraint({ error: { code: 'resource_constraint' } }), true);
  assert.equal(isExplicitResourceConstraint({ message: 'resource_constraint occurred in source text' }), false);
  assert.deepEqual(buildEvidenceExportArgs(exportSchema, destination), { output_path: destination, overwrite: false });
  assert.throws(() => buildEvidenceExportArgs({ type: 'object', properties: { path: { type: 'string' } },
    required: ['path', 'format'] }, destination), { code: 'REA_EVIDENCE_EXPORT_SCHEMA_UNSUPPORTED' });
});

test('evidence export validates path, byte size, digest, JSON structure, record count, and unknown count', () => {
  const { bytes, summary } = fixture();
  const result = validateEvidenceExportBytes(bytes, summary, destination);
  assert.equal(result.sha256, summary.sha256);
  assert.equal(result.records, 1);
  assert.equal(result.unknowns, 0);
  assert.deepEqual(result.topLevelKeys, ['records', 'unknowns']);
  assert.deepEqual(result.parsed.records[0].findings[0], { summary: 'Fixture evidence' });
});

test('evidence export fails closed on mismatched summaries, incomplete evidence, secrets, invalid JSON, and oversize files', () => {
  const good = fixture();
  assert.throws(() => validateEvidenceExportBytes(good.bytes,
    { ...good.summary, path: '/tmp/other.json' }, destination), { code: 'REA_EVIDENCE_EXPORT_SUMMARY_MISMATCH' });
  assert.throws(() => validateEvidenceExportBytes(good.bytes,
    { ...good.summary, bytes: good.summary.bytes + 1 }, destination), { code: 'REA_EVIDENCE_EXPORT_SUMMARY_MISMATCH' });
  assert.throws(() => validateEvidenceExportBytes(good.bytes,
    { ...good.summary, sha256: '0'.repeat(64) }, destination), { code: 'REA_EVIDENCE_EXPORT_DIGEST_MISMATCH' });

  const incomplete = fixture({ unknowns: [{ reason: 'unknown' }] });
  assert.throws(() => validateEvidenceExportBytes(incomplete.bytes, incomplete.summary, destination),
    { code: 'REA_EVIDENCE_INCOMPLETE' });
  const secret = fixture({ records: [{ token: `0x${'a'.repeat(64)}` }] });
  assert.throws(() => validateEvidenceExportBytes(secret.bytes, secret.summary, destination),
    { code: 'REA_EVIDENCE_PRIVATE_MATERIAL_BLOCKED' });

  const invalidBytes = Buffer.from('{');
  assert.throws(() => validateEvidenceExportBytes(invalidBytes,
    { path: destination, bytes: invalidBytes.length, records: 1, unknowns: 0 }, destination),
  { code: 'REA_EVIDENCE_EXPORT_INVALID' });
  assert.throws(() => validateEvidenceExportBytes(Buffer.alloc(MAX_REA_EXPORTED_EVIDENCE_BYTES + 1),
    { path: destination, bytes: MAX_REA_EXPORTED_EVIDENCE_BYTES + 1, records: 1, unknowns: 0 }, destination),
  { code: 'REA_EVIDENCE_TOO_LARGE' });
});
