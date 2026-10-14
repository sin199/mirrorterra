import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containsPrivateMaterial } from './artifacts.js';

export const MAX_REA_EXPORTED_EVIDENCE_BYTES = 40 * 1024 * 1024;

function evidenceError(code) {
  return Object.assign(new Error(code), { code });
}

const RESOURCE_CONSTRAINT_KEYS = new Set([
  'status', 'code', 'error', 'errorcode', 'error_code', 'type', 'kind', 'classification', 'outcome', 'reason', 'message'
]);

export function isExplicitResourceConstraint(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.slice(0, 100).some((item) => isExplicitResourceConstraint(item, depth + 1));
  if (typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (RESOURCE_CONSTRAINT_KEYS.has(key.toLowerCase())
        && typeof item === 'string' && item.trim().toLowerCase() === 'resource_constraint') return true;
    if (item && typeof item === 'object' && isExplicitResourceConstraint(item, depth + 1)) return true;
  }
  return false;
}

function exportPathProperty(schema) {
  const properties = schema?.properties;
  if (!schema || schema.type !== 'object' || !properties || typeof properties !== 'object') {
    throw evidenceError('REA_EVIDENCE_EXPORT_SCHEMA_UNSUPPORTED');
  }
  const candidates = Object.entries(properties).filter(([name, property]) =>
    typeof property?.type === 'string' && property.type === 'string'
      && /path/i.test(name) && !/(?:input|source|artifact)/i.test(name));
  if (candidates.length !== 1) throw evidenceError('REA_EVIDENCE_EXPORT_SCHEMA_UNSUPPORTED');
  return candidates[0][0];
}

export function buildEvidenceExportArgs(schema, destinationPath) {
  const pathProperty = exportPathProperty(schema);
  const properties = schema.properties;
  const overwriteProperty = Object.keys(properties).find((name) => name.toLowerCase() === 'overwrite');
  const allowedRequired = new Set([pathProperty, ...(overwriteProperty ? [overwriteProperty] : [])]);
  if ((schema.required || []).some((name) => !allowedRequired.has(name))) {
    throw evidenceError('REA_EVIDENCE_EXPORT_SCHEMA_UNSUPPORTED');
  }
  const args = { [pathProperty]: destinationPath };
  if (overwriteProperty) {
    if (properties[overwriteProperty]?.type !== 'boolean') throw evidenceError('REA_EVIDENCE_EXPORT_SCHEMA_UNSUPPORTED');
    args[overwriteProperty] = false;
  }
  return args;
}

const SUMMARY_KEYS = Object.freeze({
  path: new Set(['path', 'outputpath', 'filepath', 'destination']),
  bytes: new Set(['bytes', 'bytesize', 'sizebytes', 'filesize']),
  sha256: new Set(['sha256', 'sha_256', 'digest', 'checksum']),
  records: new Set(['records', 'recordcount', 'record_count']),
  unknowns: new Set(['unknowns', 'unknowncount', 'unknown_count'])
});

function collectValues(value, keys, output = [], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 1_000)) collectValues(item, keys, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value).slice(0, 2_000)) {
    if (keys.has(key.toLowerCase())) output.push(item);
    if (item && typeof item === 'object') collectValues(item, keys, output, depth + 1);
  }
  return output;
}

function uniqueValue(value, keys, name, required = true) {
  const values = collectValues(value, keys);
  if (!values.length) {
    if (!required) return undefined;
    throw evidenceError('REA_EVIDENCE_EXPORT_SUMMARY_INVALID');
  }
  const normalized = new Map(values.map((item) => [JSON.stringify(item), item]));
  if (normalized.size !== 1) throw evidenceError('REA_EVIDENCE_EXPORT_SUMMARY_INVALID');
  return [...normalized.values()][0];
}

function safeCount(value, name) {
  if (Array.isArray(value)) return value.length;
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw evidenceError('REA_EVIDENCE_EXPORT_SUMMARY_INVALID');
  return parsed;
}

function fileCounts(bundle) {
  const records = collectValues(bundle, SUMMARY_KEYS.records);
  const unknowns = collectValues(bundle, SUMMARY_KEYS.unknowns);
  return {
    records: records.map((value) => safeCount(value, 'records')),
    unknowns: unknowns.map((value) => safeCount(value, 'unknowns'))
  };
}

function hasRecordPayload(value, depth = 0) {
  if (depth > 10 || value === null || typeof value !== 'object') return false;
  const payloadKeys = new Set(['record', 'records', 'evidence', 'analysis', 'analyses', 'results', 'events', 'observations']);
  for (const [key, item] of Object.entries(value).slice(0, 2_000)) {
    if (payloadKeys.has(key.toLowerCase()) && item && typeof item === 'object'
        && (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0)) return true;
    if (item && typeof item === 'object' && hasRecordPayload(item, depth + 1)) return true;
  }
  return false;
}

export function validateEvidenceExportBytes(bytes, summary, destinationPath) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw evidenceError('REA_EVIDENCE_EXPORT_INCOMPLETE');
  if (bytes.length > MAX_REA_EXPORTED_EVIDENCE_BYTES) throw evidenceError('REA_EVIDENCE_TOO_LARGE');

  const reportedPath = uniqueValue(summary, SUMMARY_KEYS.path, 'path');
  const reportedBytes = safeCount(uniqueValue(summary, SUMMARY_KEYS.bytes, 'bytes'), 'bytes');
  const records = safeCount(uniqueValue(summary, SUMMARY_KEYS.records, 'records'), 'records');
  const unknowns = safeCount(uniqueValue(summary, SUMMARY_KEYS.unknowns, 'unknowns'), 'unknowns');
  if (typeof reportedPath !== 'string' || path.resolve(reportedPath) !== path.resolve(destinationPath)
      || reportedBytes !== bytes.length) throw evidenceError('REA_EVIDENCE_EXPORT_SUMMARY_MISMATCH');
  if (records < 1 || unknowns !== 0) throw evidenceError('REA_EVIDENCE_INCOMPLETE');

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reportedDigest = uniqueValue(summary, SUMMARY_KEYS.sha256, 'sha256', false);
  if (reportedDigest !== undefined) {
    const normalizedDigest = String(reportedDigest).replace(/^sha256:/i, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedDigest) || normalizedDigest !== sha256) {
      throw evidenceError('REA_EVIDENCE_EXPORT_DIGEST_MISMATCH');
    }
  }
  if (containsPrivateMaterial(bytes)) throw evidenceError('REA_EVIDENCE_PRIVATE_MATERIAL_BLOCKED');

  let text;
  let parsed;
  try {
    text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid UTF-8');
    parsed = JSON.parse(text);
  } catch {
    throw evidenceError('REA_EVIDENCE_EXPORT_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length === 0 || !hasRecordPayload(parsed)) {
    throw evidenceError('REA_EVIDENCE_INCOMPLETE');
  }
  const counts = fileCounts(parsed);
  if (counts.records.some((count) => count !== records)
      || counts.unknowns.some((count) => count !== unknowns)) {
    throw evidenceError('REA_EVIDENCE_EXPORT_SUMMARY_MISMATCH');
  }
  return { bytes, sha256, parsed, records, unknowns, topLevelKeys: Object.keys(parsed) };
}

async function readBounded(handle, maxBytes) {
  const chunks = [];
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const length = Math.min(chunk.length, maxBytes + 1 - total);
    if (length <= 0) throw evidenceError('REA_EVIDENCE_TOO_LARGE');
    const { bytesRead } = await handle.read(chunk, 0, length, total);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw evidenceError('REA_EVIDENCE_TOO_LARGE');
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

async function removeTemporaryDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
  try {
    await lstat(directory);
    throw evidenceError('REA_EVIDENCE_TEMP_CLEANUP_FAILED');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function exportEvidenceBundle(rea, { timeoutMs = 30_000 } = {}) {
  if (!rea?.hasTool?.('export_evidence_bundle') || typeof rea.getToolSchema !== 'function') {
    throw evidenceError('REA_EVIDENCE_EXPORT_UNAVAILABLE');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mirrorterra-rea-evidence-'));
  const destinationPath = path.join(directory, `bundle-${randomUUID()}.json`);
  try {
    await chmod(directory, 0o700);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
      throw evidenceError('REA_EVIDENCE_TEMP_DIRECTORY_INVALID');
    }
    const entries = await readdir(directory);
    if (entries.length !== 0) throw evidenceError('REA_EVIDENCE_EXPORT_PATH_CONFLICT');
    const schema = rea.getToolSchema('export_evidence_bundle');
    const args = buildEvidenceExportArgs(schema, destinationPath);
    const result = await rea.callTool('export_evidence_bundle', args, timeoutMs);
    const summary = result?.parsed;
    const reportedPath = uniqueValue(summary, SUMMARY_KEYS.path, 'path');
    if (typeof reportedPath !== 'string' || path.resolve(reportedPath) !== path.resolve(destinationPath)) {
      throw evidenceError('REA_EVIDENCE_EXPORT_SUMMARY_MISMATCH');
    }
    if ((await readdir(directory)).length !== 1) throw evidenceError('REA_EVIDENCE_EXPORT_INCOMPLETE');
    const actualPath = path.join(directory, path.basename(destinationPath));
    const actualRealPath = await realpath(actualPath);
    const directoryRealPath = await realpath(directory);
    if (path.dirname(actualRealPath) !== directoryRealPath) throw evidenceError('REA_EVIDENCE_EXPORT_PATH_INVALID');
    const linkInfo = await lstat(actualPath);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || (linkInfo.mode & 0o077) !== 0) {
      throw evidenceError('REA_EVIDENCE_EXPORT_FILE_TYPE_INVALID');
    }
    if (linkInfo.size < 1) throw evidenceError('REA_EVIDENCE_EXPORT_INCOMPLETE');
    if (linkInfo.size > MAX_REA_EXPORTED_EVIDENCE_BYTES) throw evidenceError('REA_EVIDENCE_TOO_LARGE');
    const handle = await open(actualPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const openInfo = await handle.stat();
      if (!openInfo.isFile() || openInfo.dev !== linkInfo.dev || openInfo.ino !== linkInfo.ino
          || openInfo.size !== linkInfo.size) throw evidenceError('REA_EVIDENCE_EXPORT_FILE_TYPE_INVALID');
      bytes = await readBounded(handle, MAX_REA_EXPORTED_EVIDENCE_BYTES);
      const afterRead = await handle.stat();
      if (afterRead.size !== openInfo.size || afterRead.mtimeMs !== openInfo.mtimeMs) {
        throw evidenceError('REA_EVIDENCE_EXPORT_FILE_CHANGED');
      }
    } finally { await handle.close(); }
    return validateEvidenceExportBytes(bytes, summary, destinationPath);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('REA_')) throw error;
    throw evidenceError('REA_EVIDENCE_EXPORT_FAILED');
  } finally {
    await removeTemporaryDirectory(directory);
  }
}
