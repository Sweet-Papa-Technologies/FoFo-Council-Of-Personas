// CLI to manage Council secrets in the macOS Keychain.
//   npm run secrets:set     interactively store LITELLM_* + COUNCIL_MODEL
//   npm run secrets:show     show what's set and where it resolves from
//   npm run secrets:clear    remove all managed keys from the Keychain
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import 'dotenv/config';
import {
  KEYCHAIN_SERVICE,
  MANAGED_KEYS,
  keychainSet,
  keychainDelete,
  keychainGet,
  secretSource,
} from '../server/src/secrets';

const PROMPTS: Record<(typeof MANAGED_KEYS)[number], string> = {
  LITELLM_BASE_URL: 'LiteLLM base URL (e.g. https://your-litellm-host)',
  LITELLM_API_KEY: 'LiteLLM API key (sk-...)',
  COUNCIL_MODEL: 'Default council model alias (e.g. gemini-pro)',
};

function requireDarwin(): void {
  if (process.platform !== 'darwin') {
    console.error(
      'Keychain commands require macOS. On other platforms use a .env file (see .env.example).',
    );
    process.exit(1);
  }
}

async function set(): Promise<void> {
  requireDarwin();
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`Storing secrets in Keychain service "${KEYCHAIN_SERVICE}".`);
  console.log('Press Enter to keep the current value.\n');
  try {
    for (const key of MANAGED_KEYS) {
      const current = keychainGet(key);
      const hint = current
        ? key === 'LITELLM_API_KEY'
          ? ' [currently set]'
          : ` [${current}]`
        : '';
      const answer = (await rl.question(`${PROMPTS[key]}${hint}: `)).trim();
      if (answer) {
        keychainSet(key, answer);
        console.log(`  ✓ saved ${key}`);
      } else if (current) {
        console.log(`  · kept ${key}`);
      } else {
        console.log(`  · skipped ${key} (still unset)`);
      }
    }
  } finally {
    rl.close();
  }
  console.log('\nDone. Verify with: npm run secrets:show');
}

function show(): void {
  console.log(`Keychain service: ${KEYCHAIN_SERVICE}\n`);
  for (const key of MANAGED_KEYS) {
    const src = secretSource(key);
    const resolved = keychainGet(key) ?? process.env[key];
    const shown =
      resolved == null
        ? '(unset)'
        : key === 'LITELLM_API_KEY'
          ? `${resolved.slice(0, 6)}…(${resolved.length} chars)`
          : resolved;
    console.log(`  ${key.padEnd(18)} ${String(src).padEnd(9)} ${shown}`);
  }
  console.log('\nResolution order: Keychain → .env/env.');
}

function clear(): void {
  requireDarwin();
  for (const key of MANAGED_KEYS) {
    keychainDelete(key);
    console.log(`  ✓ removed ${key} from Keychain`);
  }
  console.log('\nCleared. (.env values, if any, are untouched.)');
}

const cmd = process.argv[2];
if (cmd === 'set') await set();
else if (cmd === 'show') show();
else if (cmd === 'clear') clear();
else {
  console.error('Usage: tsx scripts/secrets.ts <set|show|clear>');
  process.exit(1);
}
