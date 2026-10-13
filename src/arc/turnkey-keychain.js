import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Turnkey } from '@turnkey/sdk-server';
import { TURNKEY_API_BASE_URL } from './turnkey-wallet-provider.js';

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
