export const WORLD_DISPLAY_NAME = 'MirrorTerra';

export function readMirrorterraEnv(name, fallbackValue, env = process.env) {
  if (typeof name !== 'string' || !name.startsWith('MIRRORTERRA_')) {
    throw new TypeError('A MIRRORTERRA_ environment variable name is required.');
  }
  const legacyName = `SYNTERRA_${name.slice('MIRRORTERRA_'.length)}`;
  if (typeof env[name] === 'string' && env[name].length > 0) return env[name];
  if (typeof env[legacyName] === 'string' && env[legacyName].length > 0) return env[legacyName];
  return fallbackValue;
}
