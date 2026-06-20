// Drives a council run against the API and exposes reactive state for the UI.
// Streams Server-Sent Events from POST /api/council/run and folds each event
// into per-member / chairman state so the page can render answers live.
import { reactive, ref } from 'vue';

export type SeatStatus = 'pending' | 'streaming' | 'done' | 'error';
export type Stage = 'idle' | 'fanout' | 'review' | 'chairman' | 'done';

export type Accent = 'red' | 'purple' | 'green' | 'gold' | 'blue';
const FALLBACK_ACCENTS: Accent[] = ['red', 'purple', 'green', 'gold', 'blue'];

export interface Source {
  title: string;
  uri: string;
}

export interface MemberState {
  id: number;
  name: string;
  label: string;
  accent: Accent;
  icon: string;
  tagline: string;
  searchEnabled: boolean;
  answer: string;
  status: SeatStatus;
  error: string | null;
  review: string;
  reviewStatus: SeatStatus | 'skipped';
  ranking: string[];
  sources: Source[];
}

export interface TallyRow {
  label: string;
  name: string;
  points: number;
  appearances: number;
}

async function* parseSSE(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        try {
          yield { event, data: JSON.parse(data) };
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}

export function useCouncil() {
  const members = reactive<MemberState[]>([]);
  const chairman = reactive({
    content: '',
    status: 'pending' as SeatStatus,
    sources: [] as Source[],
  });
  const tally = ref<TallyRow[]>([]);
  const stage = ref<Stage>('idle');
  const running = ref(false);
  const fatal = ref<string | null>(null);
  const peerReview = ref(true);

  function byId(id: number): MemberState | undefined {
    return members.find((m) => m.id === id);
  }

  function reset() {
    members.splice(0);
    chairman.content = '';
    chairman.status = 'pending';
    chairman.sources = [];
    tally.value = [];
    fatal.value = null;
    stage.value = 'idle';
  }

  function handle(event: string, data: any) {
    switch (event) {
      case 'roster':
        peerReview.value = !!data.peer_review;
        data.members.forEach((m: any, i: number) => {
          members.push({
            id: m.id,
            name: m.name,
            label: m.label,
            accent: (m.accent as Accent) || FALLBACK_ACCENTS[i % FALLBACK_ACCENTS.length],
            icon: m.icon || 'forum',
            tagline: m.tagline || `Advisor ${m.label?.split(' ').pop() ?? ''}`,
            searchEnabled: !!m.search,
            answer: '',
            status: 'pending',
            error: null,
            review: '',
            reviewStatus: data.peer_review ? 'pending' : 'skipped',
            ranking: [],
            sources: [],
          });
        });
        break;
      case 'stage':
        stage.value = data.stage;
        break;
      case 'member_start':
        { const m = byId(data.id); if (m) m.status = 'streaming'; }
        break;
      case 'member_token':
        { const m = byId(data.id); if (m) m.answer += data.delta; }
        break;
      case 'member_done':
        { const m = byId(data.id); if (m) { m.answer = data.content; m.status = 'done'; } }
        break;
      case 'member_sources':
        { const m = byId(data.id); if (m) m.sources = data.sources || []; }
        break;
      case 'member_error':
        { const m = byId(data.id); if (m) { m.status = 'error'; m.error = data.error; } }
        break;
      case 'review_start':
        { const m = byId(data.id); if (m) m.reviewStatus = 'streaming'; }
        break;
      case 'review_token':
        { const m = byId(data.id); if (m) m.review += data.delta; }
        break;
      case 'review_done':
        { const m = byId(data.id); if (m) { m.review = data.content; m.reviewStatus = 'done'; m.ranking = data.ranking || []; } }
        break;
      case 'review_error':
        { const m = byId(data.id); if (m) { m.reviewStatus = 'error'; m.review = data.error; } }
        break;
      case 'ranking_tally':
        tally.value = data.tally;
        break;
      case 'chairman_start':
        chairman.status = 'streaming';
        break;
      case 'chairman_sources':
        chairman.sources = data.sources || [];
        break;
      case 'chairman_token':
        chairman.content += data.delta;
        break;
      case 'chairman_done':
        chairman.content = data.content;
        chairman.status = 'done';
        break;
      case 'chairman_error':
        chairman.status = 'error';
        chairman.content = data.error;
        break;
      case 'fatal':
        fatal.value = data.error;
        break;
      case 'done':
        stage.value = 'done';
        break;
    }
  }

  async function ask(
    question: string,
    opts: {
      peerReview?: boolean;
      councilModel?: string;
      reviewModel?: string;
      chairmanModel?: string;
      searchOverrides?: Record<number, boolean>;
      chairmanSearch?: boolean;
    } = {},
  ) {
    if (running.value) return;
    reset();
    running.value = true;
    try {
      const res = await fetch('/api/council/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          ...(typeof opts.peerReview === 'boolean'
            ? { peer_review: opts.peerReview }
            : {}),
          ...(opts.councilModel ? { council_model: opts.councilModel } : {}),
          ...(opts.reviewModel ? { review_model: opts.reviewModel } : {}),
          ...(opts.chairmanModel ? { chairman_model: opts.chairmanModel } : {}),
          ...(opts.searchOverrides ? { search_overrides: opts.searchOverrides } : {}),
          ...(typeof opts.chairmanSearch === 'boolean'
            ? { chairman_search: opts.chairmanSearch }
            : {}),
        }),
      });
      if (!res.ok || !res.body) {
        let msg = `Request failed (HTTP ${res.status}).`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch { /* keep default */ }
        fatal.value = msg;
        return;
      }
      for await (const { event, data } of parseSSE(res.body)) {
        handle(event, data);
      }
    } catch (err) {
      fatal.value = err instanceof Error ? err.message : String(err);
    } finally {
      running.value = false;
    }
  }

  // Backend reachability for the sidebar status light.
  const online = ref<boolean | null>(null);
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const j = await res.json();
      online.value = !!j.ok;
    } catch {
      online.value = false;
    }
  }

  return {
    members, chairman, tally, stage, running, fatal, peerReview,
    online, ask, reset, checkHealth,
  };
}
