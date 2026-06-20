#!/usr/bin/env node
// Headless CLI for the Council of Personas.
//
// Runs the full three-stage flow (fan-out → peer review → chairman) with NO
// server and NO browser, then prints the result to stdout — Markdown by default
// or structured JSON with --json. Progress is written to stderr so it never
// pollutes the captured result. Designed to be driven by a Claude Skill, but
// equally usable by a human in a terminal.
import { runCouncil, type Emit } from './council';

interface ParsedArgs {
  question: string;
  json: boolean;
  quiet: boolean;
  review?: boolean; // undefined = use council.yaml default
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { question: '', json: false, quiet: false, help: false };
  const qparts: string[] = [];
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--no-review') out.review = false;
    else if (a === '--review') out.review = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else qparts.push(a);
  }
  out.question = qparts.join(' ').trim();
  return out;
}

const HELP = `Council of Personas — headless CLI

Convene a council of adversarial personas (same model, different system prompts)
that answer in parallel, peer-review each other, and a Chairman synthesizes.

Usage:
  npm run council -- "<question>" [--json] [--no-review] [--quiet]

Options:
  --json        Emit structured JSON instead of Markdown
  --no-review   Skip the peer-review stage (faster)
  --quiet       Suppress progress output on stderr
  -h, --help    Show this help

Config comes from the Keychain or .env (GEMINI_API_KEY etc.) and council.yaml.`;

interface MemberAcc {
  id: number;
  name: string;
  label: string;
  accent: string;
  tagline: string;
  answer: string;
  error: string | null;
  review: string;
  ranking: string[];
}

interface TallyRow {
  name: string;
  label: string;
  points: number;
  appearances: number;
}

const ACCENT_EMOJI: Record<string, string> = {
  red: '🔴', purple: '🟣', green: '🟢', gold: '🟡', blue: '🔵',
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (!args.question) {
    process.stderr.write('Error: provide a question. See --help.\n');
    process.exit(2);
  }

  const members = new Map<number, MemberAcc>();
  let chairman = '';
  let chairmanError: string | null = null;
  let tally: TallyRow[] = [];
  let fatal: string | null = null;
  let peerReview = true;

  const progress = (s: string) => {
    if (!args.quiet) process.stderr.write(s + '\n');
  };

  const emit: Emit = (event, data) => {
    const d = data as Record<string, any>;
    switch (event) {
      case 'roster':
        peerReview = !!d.peer_review;
        for (const m of d.members as Record<string, any>[]) {
          members.set(m.id, {
            id: m.id, name: m.name, label: m.label,
            accent: m.accent ?? '', tagline: m.tagline ?? '',
            answer: '', error: null, review: '', ranking: [],
          });
        }
        progress(`Council: ${(d.members as any[]).map((m) => m.name).join(', ')}` +
          ` · peer review ${peerReview ? 'on' : 'off'}`);
        break;
      case 'stage':
        progress(`── stage: ${d.stage} ──`);
        break;
      case 'member_done': {
        const m = members.get(d.id);
        if (m) m.answer = d.content;
        progress(`  ✓ ${m?.name ?? d.id} responded`);
        break;
      }
      case 'member_error': {
        const m = members.get(d.id);
        if (m) m.error = d.error;
        progress(`  ✗ ${m?.name ?? d.id}: ${d.error}`);
        break;
      }
      case 'review_done': {
        const m = members.get(d.id);
        if (m) { m.review = d.content; m.ranking = d.ranking || []; }
        break;
      }
      case 'ranking_tally':
        tally = d.tally;
        break;
      case 'chairman_done':
        chairman = d.content;
        progress('  ✓ Chairman synthesized');
        break;
      case 'chairman_error':
        chairmanError = d.error;
        break;
      case 'fatal':
        fatal = d.error;
        break;
    }
  };

  const ac = new AbortController();
  try {
    await runCouncil(args.question, emit, ac.signal, args.review);
  } catch (err) {
    fatal = err instanceof Error ? err.message : String(err);
  }

  if (fatal) {
    process.stderr.write(`\nCouncil failed: ${fatal}\n`);
    process.exit(1);
  }

  const memberList = [...members.values()];

  if (args.json) {
    process.stdout.write(JSON.stringify({
      question: args.question,
      peer_review: peerReview,
      chairman: { content: chairman, error: chairmanError },
      members: memberList.map((m) => ({
        id: m.id, name: m.name, label: m.label, accent: m.accent,
        status: m.error ? 'error' : 'ok',
        answer: m.answer, error: m.error,
        review: m.review || null, ranking: m.ranking,
      })),
      rankings: tally.map((t, i) => ({
        rank: i + 1, name: t.name, label: t.label,
        points: t.points, appearances: t.appearances,
      })),
    }, null, 2) + '\n');
    return;
  }

  // ----- Markdown -----
  const L: string[] = [];
  L.push('# Council of Personas');
  L.push('');
  L.push(`**Question:** ${args.question}`);
  L.push('');
  L.push("## ⚖️ Chairman's Synthesis");
  L.push('');
  L.push(chairmanError ? `> ⚠️ Chairman error: ${chairmanError}` : (chairman || '_(no synthesis produced)_'));
  L.push('');

  if (tally.length) {
    L.push('### Peer Review Ranking');
    L.push('');
    L.push('| # | Advisor | Points | Ballots |');
    L.push('|--:|---------|-------:|--------:|');
    tally.forEach((t, i) => L.push(`| ${i + 1} | ${t.name} | ${t.points} | ${t.appearances} |`));
    L.push('');
  }

  L.push('## The Council');
  L.push('');
  for (const m of memberList) {
    const emoji = ACCENT_EMOJI[m.accent] ?? '•';
    const head = `${emoji} ${m.name}${m.tagline ? ` — ${m.tagline}` : ''}`;
    L.push(`<details><summary><strong>${head}</strong></summary>`);
    L.push('');
    L.push(m.error ? `> ⚠️ ${m.error}` : (m.answer || '_(no answer)_'));
    L.push('');
    L.push('</details>');
    L.push('');
  }

  process.stdout.write(L.join('\n'));
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
