const ROBOTS_TEXT = `User-agent: *
Allow: /
Disallow: /local/
`;

export function registerPublicSystemRoutes(app, { readReadiness }) {
  if (!app?.get || typeof readReadiness !== 'function') {
    throw new TypeError('Fastify app and readiness reader are required.');
  }
  app.get('/robots.txt', async (_request, reply) => reply
    .type('text/plain; charset=utf-8')
    .send(ROBOTS_TEXT));
  app.get('/health', async (_request, reply) => {
    const readiness = await readReadiness();
    reply.header('Cache-Control', 'no-store');
    return reply.code(readiness.ready ? 200 : 503).send({
      status: readiness.status,
      service: 'mirrorterra',
      ready: readiness.ready
    });
  });
}
