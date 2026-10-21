import { createHash } from 'node:crypto';

export function publicResponseEtag(payload) {
  return `W/"${createHash('sha256').update(JSON.stringify(payload)).digest('base64url')}"`;
}

export function matchesPublicEtag(header, etag) {
  return typeof header === 'string' && header.split(',').some((part) =>
    part.trim() === '*' || part.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
}

export function sendPublicMapSnapshot(request, reply, entry) {
  reply.header('Cache-Control', 'private, no-cache');
  reply.header('ETag', entry.etag);
  if (matchesPublicEtag(request.headers['if-none-match'], entry.etag)) return reply.code(304).send();
  return entry.payload;
}
