// Three-stage orchestration: fan-out -> peer review -> chairman synthesis.
// Everything is emitted as discrete events so the transport (SSE) can stream
// them to the browser live. A failure in any one seat is captured and reported
// in that seat's events; it never aborts the run.
import {
  getConnection,
  loadCouncilConfig,
  type Persona,
  type CouncilConfig,
} from './config';
import { streamChat } from './llm';

export type Emit = (event: string, data: unknown) => void;

interface SeatResult {
  id: number;
  name: string;
  label: string; // anonymized: "Advisor A", "Advisor B", ...
  ok: boolean;
  content: string;
  error?: string;
}

function anonLabel(i: number): string {
  // A, B, ... Z, then AA, AB just in case of a very large council.
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Advisor ${s}`;
}

function tempFor(p: Persona, fallback: number): number {
  return typeof p.temperature === 'number' ? p.temperature : fallback;
}

// ---- Stage 1: fan-out --------------------------------------------------------

async function runSeat(
  conn: ReturnType<typeof getConnection>,
  cfg: CouncilConfig,
  persona: Persona,
  id: number,
  label: string,
  question: string,
  defaultModel: string,
  emit: Emit,
  signal: AbortSignal,
): Promise<SeatResult> {
  emit('member_start', { id });
  try {
    let content = '';
    content = await streamChat(
      conn,
      {
        model: persona.model ?? defaultModel,
        system: persona.system_prompt,
        user: question,
        temperature: tempFor(persona, cfg.settings.council_temperature),
        signal,
      },
      (delta) => emit('member_token', { id, delta }),
    );
    emit('member_done', { id, content });
    return { id, name: persona.name, label, ok: true, content };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit('member_error', { id, error });
    return { id, name: persona.name, label, ok: false, content: '', error };
  }
}

// ---- Stage 2: peer review ----------------------------------------------------

export interface ParsedRanking {
  raw: string[]; // ordered list of labels as the reviewer ranked them
}

function parseRanking(text: string): ParsedRanking {
  // Look for a "FINAL RANKING:" block and pull out "Advisor X" tokens in order.
  const idx = text.toUpperCase().lastIndexOf('FINAL RANKING:');
  const region = idx >= 0 ? text.slice(idx + 'FINAL RANKING:'.length) : text;
  const order: string[] = [];
  const re = /Advisor\s+([A-Z]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const label = `Advisor ${m[1].toUpperCase()}`;
    if (!order.includes(label)) order.push(label);
  }
  return { raw: order };
}

async function runReview(
  conn: ReturnType<typeof getConnection>,
  cfg: CouncilConfig,
  persona: Persona,
  self: SeatResult,
  peers: SeatResult[], // successful seats OTHER than self
  question: string,
  reviewModel: string,
  emit: Emit,
  signal: AbortSignal,
): Promise<string[] | null> {
  const id = self.id;
  emit('review_start', { id });

  const peerBlocks = peers
    .map((p) => `## ${p.label}\n${p.content}`)
    .join('\n\n');

  const labelList = peers.map((p) => p.label).join(', ');
  const user =
    `The council was asked:\n"""${question}"""\n\n` +
    `Here are anonymized answers from the OTHER advisors. Critique each one — ` +
    `note its strongest insight and its biggest flaw or blind spot — then rank them ` +
    `best-to-worst on usefulness to the asker.\n\n` +
    `${peerBlocks}\n\n` +
    `End your response with EXACTLY this block, ranking only these advisors ` +
    `(${labelList}), best first, one per line:\n\n` +
    `FINAL RANKING:\n1. Advisor <letter>\n2. Advisor <letter>\n...`;

  try {
    const content = await streamChat(
      conn,
      {
        // Peer review is the lightweight "fast" tier.
        model: reviewModel,
        system: persona.system_prompt,
        user,
        temperature: tempFor(persona, cfg.settings.council_temperature),
        signal,
      },
      (delta) => emit('review_token', { id, delta }),
    );
    const ranking = parseRanking(content);
    emit('review_done', { id, content, ranking: ranking.raw });
    return ranking.raw;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit('review_error', { id, error });
    return null;
  }
}

/** Borda-style tally: across all reviewers, who ranked highest on average. */
function tallyRankings(
  seats: SeatResult[],
  rankings: Map<number, string[]>,
): { label: string; name: string; points: number; appearances: number }[] {
  const byLabel = new Map(seats.map((s) => [s.label, s]));
  const points = new Map<string, number>();
  const appearances = new Map<string, number>();

  for (const order of rankings.values()) {
    const n = order.length;
    order.forEach((label, i) => {
      points.set(label, (points.get(label) ?? 0) + (n - i)); // 1st gets n points
      appearances.set(label, (appearances.get(label) ?? 0) + 1);
    });
  }

  return [...byLabel.values()]
    .map((s) => ({
      label: s.label,
      name: s.name,
      points: points.get(s.label) ?? 0,
      appearances: appearances.get(s.label) ?? 0,
    }))
    .sort((a, b) => b.points - a.points);
}

// ---- Stage 3: chairman -------------------------------------------------------

async function runChairman(
  conn: ReturnType<typeof getConnection>,
  cfg: CouncilConfig,
  question: string,
  seats: SeatResult[],
  rankingSummary: string | null,
  chairmanModel: string,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  emit('chairman_start', {});
  const answered = seats.filter((s) => s.ok);

  const answerBlocks = answered
    .map((s) => `### ${s.name}\n${s.content}`)
    .join('\n\n');

  const failures = seats.filter((s) => !s.ok);
  const failureNote = failures.length
    ? `\n\n(Note: ${failures
        .map((s) => s.name)
        .join(', ')} did not respond and are excluded.)`
    : '';

  const rankingBlock = rankingSummary
    ? `\n\nThe council also cross-ranked each other's answers. Aggregate peer ranking ` +
      `(best first):\n${rankingSummary}\n`
    : '';

  const user =
    `The question put to the council:\n"""${question}"""\n\n` +
    `The council's answers:\n\n${answerBlocks}${rankingBlock}${failureNote}\n\n` +
    `Now deliver your synthesis.`;

  try {
    const content = await streamChat(
      conn,
      {
        model: chairmanModel,
        system: cfg.chairman.system_prompt,
        user,
        temperature:
          cfg.chairman.temperature ?? cfg.settings.chairman_temperature,
        signal,
      },
      (delta) => emit('chairman_token', { delta }),
    );
    emit('chairman_done', { content });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit('chairman_error', { error });
  }
}

// ---- Top-level run -----------------------------------------------------------

export interface RunOptions {
  peerReview?: boolean;
  councilModel?: string; // overrides default for council seats (medium tier)
  reviewModel?: string; // overrides peer-review model (fast tier)
  chairmanModel?: string; // overrides chairman model (hard tier)
}

export async function runCouncil(
  question: string,
  emit: Emit,
  signal: AbortSignal,
  opts: RunOptions = {},
): Promise<void> {
  const cfg = loadCouncilConfig();
  const conn = getConnection();
  const peerReview = opts.peerReview ?? cfg.settings.peer_review;

  // Effective model per role — UI override → council.yaml → connection default.
  const councilModel = opts.councilModel || conn.model;
  const reviewModel = opts.reviewModel || cfg.settings.review_model || councilModel;
  const chairmanModel = opts.chairmanModel || cfg.chairman.model || conn.model;

  const roster = cfg.council.map((p, i) => ({
    persona: p,
    id: i,
    label: anonLabel(i),
  }));

  emit('roster', {
    members: roster.map((r) => ({
      id: r.id,
      name: r.persona.name,
      label: r.label,
      accent: r.persona.accent,
      icon: r.persona.icon,
      tagline: r.persona.tagline,
    })),
    peer_review: peerReview,
    chairman: cfg.chairman.name,
  });

  // Stage 1 — fan out in parallel; each seat catches its own errors.
  emit('stage', { stage: 'fanout' });
  const seats = await Promise.all(
    roster.map((r) =>
      runSeat(conn, cfg, r.persona, r.id, r.label, question, councilModel, emit, signal),
    ),
  );

  const succeeded = seats.filter((s) => s.ok);

  // Stage 2 — peer review (needs at least two answers to compare).
  let rankingSummary: string | null = null;
  if (peerReview && succeeded.length >= 2) {
    emit('stage', { stage: 'review' });
    const rankings = new Map<number, string[]>();
    await Promise.all(
      succeeded.map(async (self) => {
        const persona = roster[self.id].persona;
        const peers = succeeded.filter((p) => p.id !== self.id);
        const order = await runReview(
          conn, cfg, persona, self, peers, question, reviewModel, emit, signal,
        );
        if (order && order.length) rankings.set(self.id, order);
      }),
    );

    if (rankings.size) {
      const tally = tallyRankings(succeeded, rankings);
      emit('ranking_tally', { tally });
      rankingSummary = tally
        .map(
          (t, i) =>
            `${i + 1}. ${t.name} (${t.label}) — ${t.points} pts across ${t.appearances} ballots`,
        )
        .join('\n');
    }
  }

  // Stage 3 — chairman synthesis.
  emit('stage', { stage: 'chairman' });
  await runChairman(conn, cfg, question, seats, rankingSummary, chairmanModel, emit, signal);

  emit('done', {});
}
