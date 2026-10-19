const KEY = 'mirrorterra.followedResidents.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readFollowed(storage) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && UUID.test(id)).slice(0, 100) : []);
  } catch { return new Set(); }
}

export function toggleFollow(storage, agentId) {
  if (!UUID.test(agentId)) return readFollowed(storage);
  const followed = readFollowed(storage);
  if (followed.has(agentId)) followed.delete(agentId);
  else followed.add(agentId);
  storage.setItem(KEY, JSON.stringify([...followed]));
  return followed;
}
