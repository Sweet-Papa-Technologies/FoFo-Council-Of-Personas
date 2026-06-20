// Secret loading: macOS Keychain first, then process.env (.env via dotenv), then undefined.
// Non-darwin platforms transparently skip the Keychain and use env only.
import { execFileSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'council-of-personas';

// The config keys we know how to manage. (Values aren't all "secret", but
// keeping URL/model alongside the key in one place is convenient.)
export const MANAGED_KEYS = [
  'LITELLM_BASE_URL',
  'LITELLM_API_KEY',
  'COUNCIL_MODEL',
] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

const isDarwin = process.platform === 'darwin';

export function keychainGet(key: string): string | undefined {
  if (!isDarwin) return undefined;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const v = out.replace(/\n$/, '');
    return v.length ? v : undefined;
  } catch {
    return undefined; // not found
  }
}

export function keychainSet(key: string, value: string): void {
  if (!isDarwin) throw new Error('Keychain is only available on macOS.');
  // -U updates the entry if it already exists instead of erroring.
  execFileSync(
    'security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', key, '-w', value],
    { stdio: 'ignore' },
  );
}

export function keychainDelete(key: string): void {
  if (!isDarwin) return;
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key],
      { stdio: 'ignore' },
    );
  } catch {
    // not present — nothing to delete
  }
}

/**
 * Resolve a single secret. Keychain wins over env so a machine-local override
 * doesn't require editing .env. Returns undefined if set in neither place.
 */
export function loadSecret(key: ManagedKey): string | undefined {
  return keychainGet(key) ?? process.env[key];
}

/** Where a resolved value came from — handy for `secrets:show` and diagnostics. */
export function secretSource(key: ManagedKey): 'keychain' | 'env' | 'unset' {
  if (keychainGet(key) !== undefined) return 'keychain';
  if (process.env[key]) return 'env';
  return 'unset';
}
