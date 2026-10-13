import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Turnkey } from '@turnkey/sdk-server';
import { TURNKEY_API_BASE_URL } from './turnkey-wallet-provider.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
export async function turnkeyApiFromKeychain() {
  const values = {};
  for (const account of ['TURNKEY_ORGANIZATION_ID', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY']) {
    try {
      const result = await execute('/usr/bin/security', ['find-generic-password', '-s',
        'com.mirrorterra.turnkey-provisioning', '-a', account, '-w'], { maxBuffer: 16_384 });
      values[account] = result.stdout.trim();
    } catch {
      throw Object.assign(new Error('TURNKEY_KEYCHAIN_UNAVAILABLE'), { code: 'TURNKEY_KEYCHAIN_UNAVAILABLE' });
    }
  }
  if (!/^[0-9a-f]{64}$/i.test(values.TURNKEY_API_PRIVATE_KEY)) {
    throw Object.assign(new Error('TURNKEY_KEYCHAIN_PRIVATE_KEY_INVALID'), { code: 'TURNKEY_KEYCHAIN_PRIVATE_KEY_INVALID' });
  }
  const api = new Turnkey({ apiBaseUrl: TURNKEY_API_BASE_URL,
    apiPublicKey: values.TURNKEY_API_PUBLIC_KEY, apiPrivateKey: values.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: values.TURNKEY_ORGANIZATION_ID }).apiClient();
  return { api, rootOrganizationId: values.TURNKEY_ORGANIZATION_ID, publicKey: values.TURNKEY_API_PUBLIC_KEY };
}

export async function turnkeyApiFromSystemdCredentials(env = process.env) {
  const directory = env.CREDENTIALS_DIRECTORY;
  if (!path.isAbsolute(directory || '')) {
    throw Object.assign(new Error('TURNKEY_SYSTEMD_CREDENTIALS_UNAVAILABLE'),
      { code: 'TURNKEY_SYSTEMD_CREDENTIALS_UNAVAILABLE' });
  }
  const values = {};
  try {
    for (const account of ['TURNKEY_ORGANIZATION_ID', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY']) {
      values[account] = (await readFile(path.join(directory, account), 'utf8')).trim();
    }
  } catch {
    throw Object.assign(new Error('TURNKEY_SYSTEMD_CREDENTIALS_UNAVAILABLE'),
      { code: 'TURNKEY_SYSTEMD_CREDENTIALS_UNAVAILABLE' });
  }
  if (!/^[0-9a-f]{64}$/i.test(values.TURNKEY_API_PRIVATE_KEY)
      || !values.TURNKEY_ORGANIZATION_ID || !values.TURNKEY_API_PUBLIC_KEY) {
    throw Object.assign(new Error('TURNKEY_SYSTEMD_CREDENTIALS_INVALID'),
      { code: 'TURNKEY_SYSTEMD_CREDENTIALS_INVALID' });
  }
  const api = new Turnkey({ apiBaseUrl: TURNKEY_API_BASE_URL,
    apiPublicKey: values.TURNKEY_API_PUBLIC_KEY, apiPrivateKey: values.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: values.TURNKEY_ORGANIZATION_ID }).apiClient();
  return { api, rootOrganizationId: values.TURNKEY_ORGANIZATION_ID,
    publicKey: values.TURNKEY_API_PUBLIC_KEY };
}
