// Local/SSH administrative CLI only; never mounted as a server route.
import { readFile } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import pg from 'pg';
import { EXTERNAL2_DEFAULTS, PLATFORM_OPERATOR_ID } from '../src/external2.js';
import { assertMigrationDatabaseUrlHasUsername } from '../src/database-migrations.js';

const [mode, file] = process.argv.slice(2);
if (!['register-operator','set-policy'].includes(mode) || !file) throw new Error('Usage: external2-admin.mjs register-operator|set-policy <json-file>');
const input = JSON.parse(await readFile(file, 'utf8'));
if (process.env.SYNTERRA_MIGRATION_ACK !== 'I_CONFIRMED_TARGET_BACKUP_AND_WORLD_ID') {
  throw new Error('Explicit migration target acknowledgement required');
}
const connectionString = assertMigrationDatabaseUrlHasUsername(process.env.SYNTERRA_MIGRATION_DATABASE_URL);
const db = new pg.Client({ connectionString });
await db.connect();
try {
  await db.query('BEGIN');
  if (mode==='register-operator') {
    if (!/^[0-9a-f-]{36}$/i.test(input.id || '') || input.id===PLATFORM_OPERATOR_ID
        || typeof input.name!=='string' || input.name.trim().length<2 || input.name.trim().length>120
        || typeof input.publicKey!=='string') throw new Error('Invalid operator registration');
    const key = createPublicKey(input.publicKey);
    if (key.asymmetricKeyType!=='ed25519') throw new Error('Operator key must be Ed25519');
    const pem = key.export({ format: 'pem', type: 'spki' }).toString();
    await db.query(`INSERT INTO world_external_operators(id,name,public_key,independent) VALUES($1,$2,$3,$4)`,
      [input.id, input.name.trim(), pem, input.independent !== false]);
  } else {
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !Object.hasOwn(EXTERNAL2_DEFAULTS,key))) throw new Error('Unknown policy field; treasury address and reward caps are not configurable');
    for (const key of keys) {
      if (typeof EXTERNAL2_DEFAULTS[key]==='boolean' && typeof input[key]!=='boolean') throw new Error(`Invalid boolean: ${key}`);
      if (typeof EXTERNAL2_DEFAULTS[key]==='number' && (!Number.isSafeInteger(input[key]) || input[key]<1)) throw new Error(`Invalid threshold: ${key}`);
    }
    await db.query(`UPDATE world_external2_policy SET ${keys.map((key,i) => `${key}=$${i+1}`).join(',')} WHERE singleton`, keys.map((key) => input[key]));
  }
  await db.query('COMMIT');
  process.stdout.write(`${mode}: committed\n`);
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
