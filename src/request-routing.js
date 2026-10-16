const AUTH_EXEMPT_EXACT_PATHS = new Set([
  '/', '/styles.css', '/app.js', '/world3d.js', '/market-screen.js', '/plaza-bar.js',
  '/vendor/three.module.min.js', '/v6-observer-status.js', '/og.jpg', '/favicon.svg',
  '/apple-touch-icon.png', '/robots.txt', '/health', '/public/market-ticker', '/public/stats',
  '/public/map-data', '/public/world-evolution/proposals', '/public/world-evolution/gaps',
  '/v1/agents/challenges', '/v1/agents'
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
    || /^\/public\/residents\/[^/]+$/.test(pathOnly)) return true;
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
    || pathOnly === '/public/world-evolution/gaps' || /^\/public\/residents\/[^/]+$/.test(pathOnly);
}

export async function enforcePublicApiReadiness({ pathOnly, readReadiness, reply }) {
  if (!isReadinessGatedPublicApiPath(pathOnly)) return true;
  const readiness = await readReadiness();
  if (readiness.ready) return true;
  reply.code(503).send({ error: 'SERVICE_NOT_READY' });
  return false;
}
