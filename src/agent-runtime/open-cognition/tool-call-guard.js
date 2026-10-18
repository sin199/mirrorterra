import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalToolCallArgs(request) {
  const args = Object.fromEntries(Object.entries(request || {})
    .filter(([key]) => key !== 'id' && key !== 'capability'));
  return JSON.stringify(canonicalize(args));
}

export function toolCallFingerprint(request) {
  const identity = JSON.stringify({ capability: request?.capability,
    args: JSON.parse(canonicalToolCallArgs(request)) });
  return createHash('sha256').update(identity).digest('hex');
}

function oscillationStart(fingerprints, start) {
  if (start + 3 >= fingerprints.length) return false;
  const first = fingerprints[start];
  const second = fingerprints[start + 1];
  return first !== second && first === fingerprints[start + 2]
    && second === fingerprints[start + 3];
}

/** Deduplicate only a single already-validated, bounded tool request batch. */
export function guardToolRequests(requests) {
  const batch = Array.isArray(requests) ? requests : [];
  const fingerprints = batch.map(toolCallFingerprint);
  const oscillating = new Map();

  for (let start = 0; start + 3 < fingerprints.length; start += 1) {
    if (!oscillationStart(fingerprints, start)) continue;
    let index = start + 2;
    while (index < fingerprints.length
        && fingerprints[index] === fingerprints[start + ((index - start) % 2)]) {
      oscillating.set(index, start);
      index += 1;
    }
    start = index - 1;
  }

  const accepted = [];
  const firstIndexByFingerprint = new Map();
  const suppressed = [];
  for (let index = 0; index < batch.length; index += 1) {
    const request = batch[index];
    const fingerprint = fingerprints[index];
    const cycleStart = oscillating.get(index);
    if (cycleStart !== undefined) {
      suppressed.push({ code: 'TOOL_CALL_OSCILLATION', index,
        requestId: request.id, fingerprint, cycleStartIndex: cycleStart, cycleLength: 2 });
      continue;
    }
    if (firstIndexByFingerprint.has(fingerprint)) {
      const firstIndex = firstIndexByFingerprint.get(fingerprint);
      suppressed.push({ code: 'DUPLICATE_TOOL_CALL', index, requestId: request.id,
        fingerprint, duplicateOfIndex: firstIndex, duplicateOfRequestId: batch[firstIndex].id });
      continue;
    }
    firstIndexByFingerprint.set(fingerprint, index);
    accepted.push(request);
  }
  return { accepted, suppressed };
}
