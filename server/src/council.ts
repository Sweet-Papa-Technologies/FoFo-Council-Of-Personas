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
import { streamChat, type ChatAttachment, type GroundingSource } from './llm';
import { ResearchSession } from './research';

// Merge grounding sources from several origins, de-duped by URI.
function mergeSources(...lists: GroundingSource[][]): GroundingSource[] {
  const byUri = new Map<string, GroundingSource>();
  for (const list of lists) for (const s of list) if (s?.uri) byUri.set(s.uri, s);
  return [...byUri.values()];
}

export interface RunAttachment {
  name: string;
  mime: string;
  text?: string; // text-ish docs are folded into the prompt
  data?: string; // base64 bytes for images / PDFs
}

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
  search: boolean,
  attachments: ChatAttachment[],
  researchSources: GroundingSource[],
  emit: Emit,
  signal: AbortSignal,
): Promise<SeatResult> {
  emit('member_start', { id });
  try {
    const { text: content, sources } = await streamChat(
      conn,
      {
        model: persona.model ?? defaultModel,
        system: persona.system_prompt,
        user: question,
        temperature: tempFor(persona, cfg.settings.council_temperature),
        search,
        attachments,
        signal,
      },
      (delta) => emit('member_token', { id, delta }),
    );
    const allSources = mergeSources(sources, researchSources);
    if (allSources.length) emit('member_sources', { id, sources: allSources });
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
    const { text: content } = await streamChat(
      conn,
      {
        // Peer review is the lightweight "fast" tier (no web search).
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

// ---- Stage 2.5: standing Devil's Advocate (anti-framing guard) ---------------

const DEFAULT_DEVILS_ADVOCATE: Persona = {
  name: "Devil's Advocate",
  accent: 'blue',
  icon: 'gavel',
  tagline: 'Anti-Framing Dissent',
  temperature: 0.4,
  system_prompt:
    "You are the DEVIL'S ADVOCATE on an advisory council. You are shown the question and " +
    "the advisors' answers. Your ONLY job is to find where the council is CONVERGING — the " +
    'direction they mostly agree on — and argue the strongest, most credible case AGAINST it, ' +
    'no matter which way they lean. First name the emerging consensus in one sentence. Then make ' +
    'the best argument that it is wrong, premature, or an artifact of how the question was framed; ' +
    'steelman the opposite conclusion. Identify the CRUX: the specific fact that, if true, would ' +
    'flip the recommendation. If the consensus genuinely survives your strongest attack, say so and ' +
    'why. Attack the reasoning and evidence, never the people. Be sharp and specific.',
};

async function runDevilsAdvocate(
  conn: ReturnType<typeof getConnection>,
  cfg: CouncilConfig,
  persona: Persona,
  question: string,
  seats: SeatResult[], // successful seats
  brief: string,
  model: string,
  emit: Emit,
  signal: AbortSignal,
): Promise<string | null> {
  emit('devils_advocate_start', {});
  const answerBlocks = seats
    .map((s) => `### ${s.name}\n${s.content}`)
    .join('\n\n');
  const briefBlock = brief ? `\n\n${brief}\n` : '';
  const user =
    `The question put to the council:\n"""${question}"""\n\n` +
    `The council's answers:\n\n${answerBlocks}${briefBlock}\n\n` +
    `Now find where they are converging and argue the strongest case against it.`;
  try {
    const { text } = await streamChat(
      conn,
      {
        model,
        system: persona.system_prompt,
        user,
        temperature: tempFor(persona, cfg.settings.chairman_temperature),
        signal,
      },
      (delta) => emit('devils_advocate_token', { delta }),
    );
    emit('devils_advocate_done', { content: text });
    return text;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit('devils_advocate_error', { error });
    return null;
  }
}

// ---- Stage 3: chairman -------------------------------------------------------

async function runChairman(
  conn: ReturnType<typeof getConnection>,
  cfg: CouncilConfig,
  question: string,
  seats: SeatResult[],
  rankingSummary: string | null,
  dissent: string | null,
  brief: string,
  briefSources: GroundingSource[],
  chairmanModel: string,
  search: boolean,
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

  const dissentBlock = dissent
    ? `\n\nThe Devil's Advocate then challenged wherever the council was converging. ` +
      `Weigh this dissent seriously — it exists to stop framing-driven consensus from ` +
      `passing unchecked:\n\n${dissent}\n`
    : '';

  const briefBlock = brief ? `\n\n${brief}\n` : '';

  const user =
    `The question put to the council:\n"""${question}"""\n\n` +
    `The council's answers:\n\n${answerBlocks}${rankingBlock}${dissentBlock}${briefBlock}${failureNote}\n\n` +
    `Now deliver your synthesis.`;

  try {
    const { text: content, sources } = await streamChat(
      conn,
      {
        model: chairmanModel,
        system: cfg.chairman.system_prompt,
        user,
        temperature:
          cfg.chairman.temperature ?? cfg.settings.chairman_temperature,
        search,
        signal,
      },
      (delta) => emit('chairman_token', { delta }),
    );
    const allSources = mergeSources(sources, briefSources);
    if (allSources.length) emit('chairman_sources', { sources: allSources });
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
  searchOverrides?: Record<number, boolean>; // per-seat web-search override, by id
  chairmanSearch?: boolean; // web-search override for the chairman
  searchAll?: boolean; // blanket web-search override for every seat + chairman (CLI)
  attachments?: RunAttachment[]; // files attached to the question (council members see them)
  devilsAdvocate?: boolean; // run the standing Devil's Advocate stage (default: council.yaml)
  research?: boolean; // inject a shared Tavily research brief into every role (default: council.yaml)
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
  const devilsAdvocate = opts.devilsAdvocate ?? cfg.settings.devils_advocate;
  const daPersona = cfg.devils_advocate ?? DEFAULT_DEVILS_ADVOCATE;

  // Effective model per role — UI override → council.yaml → connection default.
  const councilModel = opts.councilModel || conn.model;
  const reviewModel = opts.reviewModel || cfg.settings.review_model || councilModel;
  const chairmanModel = opts.chairmanModel || cfg.chairman.model || conn.model;

  // Effective web-search per role — blanket → per-seat override → config → settings default.
  const seatSearch = (p: typeof cfg.council[number], id: number): boolean =>
    opts.searchAll ?? opts.searchOverrides?.[id] ?? p.search ?? cfg.settings.web_search;
  const chairmanSearch =
    opts.searchAll ?? opts.chairmanSearch ?? cfg.chairman.search ?? cfg.settings.web_search;

  // Attachments: text docs fold into the council members' prompt; images/PDFs go
  // to the model as binary parts. (Reviewers and the Chairman work from answers.)
  const atts = opts.attachments ?? [];
  const textBlocks = atts
    .filter((a) => typeof a.text === 'string' && a.text)
    .map((a) => `### ${a.name}\n${a.text}`);
  const binaryAtts: ChatAttachment[] = atts
    .filter((a) => a.data)
    .map((a) => ({ mime: a.mime, data: a.data as string }));
  const memberQuestion = textBlocks.length
    ? `${question}\n\n--- Attached context ---\n${textBlocks.join('\n\n')}\n--- End attached context ---`
    : question;

  // Provider-agnostic grounding: one shared research brief for every role, so
  // non-Gemini seats and the Chairman ground from the same evidence. Soft-fails.
  const researchEnabled = opts.research ?? cfg.settings.research;
  let briefText = '';
  let briefSources: GroundingSource[] = [];
  if (researchEnabled) {
    const session = new ResearchSession();
    if (session.enabled) {
      emit('stage', { stage: 'research' });
      const brief = await session.brief(question, signal);
      if (brief) {
        briefText = brief.text;
        briefSources = brief.sources;
        emit('research_done', { sources: briefSources });
      }
    } else {
      emit('research_skipped', { reason: 'no Tavily API key configured' });
    }
  }
  const groundedQuestion = briefText ? `${memberQuestion}\n\n${briefText}` : memberQuestion;

  const roster = cfg.council.map((p, i) => ({
    persona: p,
    id: i,
    label: anonLabel(i),
    search: seatSearch(p, i),
  }));

  emit('roster', {
    members: roster.map((r) => ({
      id: r.id,
      name: r.persona.name,
      label: r.label,
      accent: r.persona.accent,
      icon: r.persona.icon,
      tagline: r.persona.tagline,
      search: r.search,
    })),
    peer_review: peerReview,
    chairman: cfg.chairman.name,
    chairman_search: chairmanSearch,
    research: !!researchEnabled,
    devils_advocate: devilsAdvocate
      ? { name: daPersona.name, accent: daPersona.accent, icon: daPersona.icon, tagline: daPersona.tagline }
      : null,
  });

  // Stage 1 — fan out in parallel; each seat catches its own errors.
  emit('stage', { stage: 'fanout' });
  const seats = await Promise.all(
    roster.map((r) =>
      runSeat(conn, cfg, r.persona, r.id, r.label, groundedQuestion, councilModel, r.search, binaryAtts, briefSources, emit, signal),
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

  // Stage 2.5 — standing Devil's Advocate (needs at least two answers to find a
  // convergence to argue against). Runs on the fast/peer-review tier by default.
  let dissent: string | null = null;
  if (devilsAdvocate && succeeded.length >= 2) {
    emit('stage', { stage: 'devils_advocate' });
    const daModel = daPersona.model || reviewModel;
    dissent = await runDevilsAdvocate(conn, cfg, daPersona, question, succeeded, briefText, daModel, emit, signal);
  }

  // Stage 3 — chairman synthesis.
  emit('stage', { stage: 'chairman' });
  await runChairman(conn, cfg, question, seats, rankingSummary, dissent, briefText, briefSources, chairmanModel, chairmanSearch, emit, signal);

  emit('done', {});
}
