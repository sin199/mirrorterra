export const MIRRORTERRA_CANONICAL_URL = 'https://mirrorterra.com';
const CANONICAL_HOST = new URL(MIRRORTERRA_CANONICAL_URL).hostname;
const WWW_HOST = `www.${CANONICAL_HOST}`;

function normalizedHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return '';
  try { return new URL(`http://${hostHeader}`).hostname.toLowerCase(); }
  catch { return ''; }
}

export function publicHostPolicy(hostHeader, requestUrl) {
  const host = normalizedHost(hostHeader);
  const rawUrl = typeof requestUrl === 'string' ? requestUrl : '/';

  if (host === WWW_HOST) {
    const safePath = rawUrl.startsWith('/') && !rawUrl.startsWith('//') ? rawUrl : '/';
    return { action: 'redirect', location: `${MIRRORTERRA_CANONICAL_URL}${safePath}` };
  }

  if (host !== CANONICAL_HOST) return null;
  const pathOnly = rawUrl.split(/[?#]/, 1)[0] || '/';
  if (pathOnly.startsWith('/health/') || pathOnly === '/local' || pathOnly.startsWith('/local/')) {
    return { action: 'not_found' };
  }
  return null;
}
