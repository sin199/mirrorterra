const AUTH_EXEMPT_EXACT_PATHS = new Set([
  '/', '/styles.css', '/app.js', '/world3d.js', '/market-screen.js', '/plaza-bar.js', '/world-places3d.js',
  '/vendor/three.module.min.js', '/v6-observer-status.js', '/ui-section-state.js', '/og.jpg', '/favicon.svg',
  '/apple-touch-icon.png', '/robots.txt', '/health', '/public/market-ticker', '/public/stats',
  '/public/map-data', '/public/world-evolution/proposals', '/public/world-evolution/gaps',
  '/v1/agents/challenges', '/v1/agents', '/observability.js', '/follow-state.js', '/public-view-state.js', '/i18n.js',
  '/api/world/summary', '/api/world/feed', '/api/world/intelligence',
  '/api/world/autonomy', '/api/world/health', '/api/agents', '/world'
]);

const LOCAL_AUTH_EXEMPT_EXACT_PATHS = new Set([
  '/local/health', '/local/map-data', '/local/research-status'
]);

export function requestPathOnly(rawUrl) {
  return (typeof rawUrl === 'string' ? rawUrl : '').split(/[?#]/, 1)[0] || '/';
}

export function isAuthExemptRoutePath(pathOnly, { allowLocalRoutes = false,
  allowCognitionDiagnostics = false } = {}) {
  if (AUTH_EXEMPT_EXACT_PATHS.has(pathOnly) || pathOnly.startsWith('/fonts/')
    || /^\/public\/residents\/[^/]+$/.test(pathOnly)
    || /^\/api\/agents\/[^/]+\/(?:summary|timeline)$/.test(pathOnly)) return true;
  if (allowLocalRoutes && (LOCAL_AUTH_EXEMPT_EXACT_PATHS.has(pathOnly)
    || /^\/local\/map-data\/residents\/[^/]+$/.test(pathOnly))) return true;
  return allowCognitionDiagnostics && pathOnly === '/local/cognition-diagnostics';
}

export function requestNeedsAgentAuth({ is404 = false, pathOnly, allowLocalRoutes = false,
  allowCognitionDiagnostics = false } = {}) {
  if (is404) return false;
  return !isAuthExemptRoutePath(pathOnly, { allowLocalRoutes, allowCognitionDiagnostics });
}

export function isReadinessGatedPublicApiPath(pathOnly) {
  return pathOnly === '/public/market-ticker' || pathOnly === '/public/stats'
    || pathOnly === '/public/map-data' || pathOnly === '/public/world-evolution/proposals'
    || pathOnly === '/public/world-evolution/gaps' || /^\/public\/residents\/[^/]+$/.test(pathOnly)
    || pathOnly.startsWith('/api/world/') || pathOnly === '/api/agents'
    || /^\/api\/agents\/[^/]+\/(?:summary|timeline)$/.test(pathOnly);
}

export async function enforcePublicApiReadiness({ pathOnly, readReadiness, reply }) {
  if (!isReadinessGatedPublicApiPath(pathOnly)) return true;
  const readiness = await readReadiness();
  if (readiness.ready) return true;
  reply.code(503).send({ error: 'SERVICE_NOT_READY' });
  return false;
}
