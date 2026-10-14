const ORIGIN = 'https://api.github.com';
const MAX_RESPONSE_BYTES = 128_000;
const MAX_TEXT = 12_000;

function fail(code) { return Object.assign(new Error(code), { code }); }

function redact(text) {
  return text.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}\b/g, '[redacted-token]')
    .replace(/(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)[\s\S]*?(-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
      '[redacted-private-key]');
}

function endpoint(request) {
  const repo = request.owner && request.repo
    ? `/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}` : null;
  switch (request.operation) {
    case 'search_repositories': return `/search/repositories?q=${encodeURIComponent(request.query)}&per_page=5`;
    case 'repository': return repo;
    case 'contents': return `${repo}/contents/${request.path.split('/').map(encodeURIComponent).join('/')}`;
    case 'issues': return `${repo}/issues?state=all&per_page=8`;
    default: throw fail('GITHUB_OPERATION_UNSUPPORTED');
  }
}

function normalize(request, payload) {
  if (request.operation === 'search_repositories') return { totalCount: Number(payload.total_count) || 0,
    repositories: (payload.items || []).slice(0, 5).map((item) => ({ fullName: item.full_name,
      description: redact(String(item.description || '').slice(0, 500)), url: item.html_url,
      updatedAt: item.updated_at, defaultBranch: item.default_branch })) };
  if (request.operation === 'repository') return { fullName: payload.full_name,
    description: redact(String(payload.description || '').slice(0, 800)), url: payload.html_url,
    defaultBranch: payload.default_branch, updatedAt: payload.updated_at, license: payload.license?.spdx_id || null };
  if (request.operation === 'issues') return { issues: (Array.isArray(payload) ? payload : []).slice(0, 8)
    .map((item) => ({ number: item.number, title: redact(String(item.title || '').slice(0, 400)),
      state: item.state, url: item.html_url, updatedAt: item.updated_at,
      bodyExcerpt: redact(String(item.body || '').slice(0, 1000)) })) };
  if (Array.isArray(payload)) return { entries: payload.slice(0, 40).map((item) => ({
    name: item.name, path: item.path, type: item.type, size: item.size, sha: item.sha })) };
  if (payload.type !== 'file' || payload.encoding !== 'base64'
      || typeof payload.content !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(payload.content)) {
    throw fail('GITHUB_CONTENT_UNSUPPORTED');
  }
  const bytes = Buffer.from(payload.content, 'base64');
  if (bytes.length > MAX_RESPONSE_BYTES || bytes.includes(0)) throw fail('GITHUB_CONTENT_NOT_TEXT');
  return { path: payload.path, sha: payload.sha, size: payload.size,
    contentExcerpt: redact(bytes.toString('utf8').slice(0, MAX_TEXT)), truncated: bytes.length > MAX_TEXT };
}

// Only public api.github.com GET endpoints are reachable. No credential or
// caller-supplied URL is accepted, and all returned text is untrusted evidence.
export async function readPublicGitHub(request, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const path = endpoint(request);
  if (!path || path.includes('undefined')) throw fail('GITHUB_REQUEST_INVALID');
  let response;
  try { response = await fetchImpl(`${ORIGIN}${path}`, { method: 'GET', redirect: 'error',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'MirrorTerra-Resident-Research' },
    signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw fail('GITHUB_REQUEST_FAILED'); }
  if (!response.ok) throw fail(response.status === 403 || response.status === 429
    ? 'GITHUB_RATE_LIMITED' : 'GITHUB_HTTP_ERROR');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw fail('GITHUB_RESPONSE_TOO_LARGE');
  let payload;
  try { payload = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw fail('GITHUB_RESPONSE_INVALID'); }
  return { source: `${ORIGIN}${path}`, observedAt: new Date().toISOString(),
    operation: request.operation, data: normalize(request, payload) };
}
