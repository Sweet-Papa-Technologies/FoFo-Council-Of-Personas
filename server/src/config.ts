// Loads connection config (from Keychain/env) and the council roster (council.yaml).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import 'dotenv/config';
import { keychainGet } from './secrets';

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root is two levels up from server/src
export const REPO_ROOT = resolve(__dirname, '../..');

export interface Connection {
  baseUrl: string; // already normalized to end at /v1/chat/completions's parent
  apiKey: string;
  model: string; // default model for any seat that doesn't override
}

export interface Persona {
  name: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  // When true, this seat can run live Google Search grounding (Gemini native).
  search?: boolean;
  // Optional UI hints (theming only — passed through to the browser):
  accent?: string; // 'red' | 'purple' | 'green' | 'gold' | 'blue' | hex
  icon?: string; // material icon name
  tagline?: string; // short subtitle under the name
}

export interface CouncilConfig {
  settings: {
    peer_review: boolean;
    council_temperature: number;
    chairman_temperature: number;
    // Optional model override for the peer-review stage (the "fast" tier).
    // Falls back to each seat's own model when unset.
    review_model?: string;
    // Default web-search state for seats that don't set `search` themselves.
    web_search: boolean;
    // Run the standing Devil's Advocate dissent stage (anti-framing guard).
    devils_advocate: boolean;
  };
  council: Persona[];
  chairman: Persona;
  // Optional editable Devil's Advocate prompt; falls back to a built-in default.
  devils_advocate?: Persona;
}

// Sensible defaults so a brand-new user only needs ONE thing: an API key.
// With just a Gemini key set, the app points itself at Google's free
// OpenAI-compatible endpoint — no LiteLLM proxy, no base URL, no model required.
const GEMINI_OPENAI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_MODEL = 'gemini-2.5-flash';

// First non-empty: Keychain(canonicalKey) → each env var in order.
function resolve1(canonicalKey: string, ...envVars: string[]): string | undefined {
  const fromKeychain = keychainGet(canonicalKey);
  if (fromKeychain) return fromKeychain;
  for (const v of envVars) {
    if (process.env[v]) return process.env[v];
  }
  return undefined;
}

/**
 * Read + validate connection settings. Provider-neutral: a LiteLLM proxy, a raw
 * OpenAI-compatible host, or a bare Gemini key all work. Throws a friendly error
 * only when no API key can be found anywhere.
 */
export function getConnection(): Connection {
  const apiKey = resolve1(
    'LITELLM_API_KEY',
    'LLM_API_KEY',
    'LITELLM_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENAI_API_KEY',
  );

  let baseUrl = resolve1(
    'LITELLM_BASE_URL',
    'LLM_BASE_URL',
    'LITELLM_BASE_URL',
    'OPENAI_BASE_URL',
  );

  const model =
    resolve1('COUNCIL_MODEL', 'COUNCIL_MODEL', 'LLM_MODEL') ?? DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error(
      'No API key found. Set one in the Keychain (npm run secrets:set) or a .env ' +
        'file — e.g. GEMINI_API_KEY=... (get a free key at https://aistudio.google.com/apikey). ' +
        'See .env.example.',
    );
  }

  // No base URL but we have a key → assume the Gemini direct endpoint.
  if (!baseUrl) baseUrl = GEMINI_OPENAI_BASE;

  return { baseUrl, apiKey, model };
}

/**
 * Build the chat-completions endpoint URL from a base URL. Handles bare hosts,
 * bases that already include an API version, and Google's Gemini OpenAI-compat
 * endpoint:
 *   https://host                                  -> https://host/v1/chat/completions
 *   https://host/v1                               -> https://host/v1/chat/completions
 *   https://.../v1beta/openai  (Gemini)           -> https://.../v1beta/openai/chat/completions
 *   https://.../chat/completions (full URL)       -> used as-is
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  // Already at an API root (…/v1, …/v1beta/openai, …/openai)? Just add the path.
  if (/\/(v\d+\w*|openai)$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

const CONFIG_PATH =
  process.env.COUNCIL_CONFIG ?? resolve(REPO_ROOT, 'council.yaml');

/** Load + validate council.yaml. Re-read per run so edits apply without restart. */
export function loadCouncilConfig(): CouncilConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    throw new Error(`Could not read council config at ${CONFIG_PATH}`);
  }

  const data = parseYaml(raw) as Partial<CouncilConfig> | null;
  if (!data || typeof data !== 'object') {
    throw new Error('council.yaml is empty or malformed.');
  }

  const council = data.council;
  if (!Array.isArray(council) || council.length === 0) {
    throw new Error('council.yaml must define a non-empty `council:` list.');
  }
  council.forEach((p, i) => {
    if (!p?.name || !p?.system_prompt) {
      throw new Error(`council[${i}] needs both "name" and "system_prompt".`);
    }
  });

  const chairman = data.chairman;
  if (!chairman?.name || !chairman?.system_prompt) {
    throw new Error('council.yaml must define a `chairman:` with name + system_prompt.');
  }

  const settings = data.settings ?? ({} as CouncilConfig['settings']);
  return {
    settings: {
      peer_review: settings.peer_review ?? true,
      council_temperature: settings.council_temperature ?? 0.9,
      chairman_temperature: settings.chairman_temperature ?? 0.3,
      review_model: settings.review_model,
      web_search: settings.web_search ?? false,
      devils_advocate: settings.devils_advocate ?? true,
    },
    council,
    chairman,
    ...(data.devils_advocate ? { devils_advocate: data.devils_advocate } : {}),
  };
}
