<template>
  <div class="cop">
    <!-- ===== Sidebar ===== -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-title font-head">The Council</div>
        <div class="brand-sub">Executive Suite</div>
      </div>

      <button class="new-session label-caps" :disabled="running" @click="newSession">
        <q-icon name="add" size="16px" /> New Session
      </button>

      <nav class="nav">
        <button class="nav-item label-caps" :class="{ active: panel === null }" @click="goHome">
          <q-icon name="psychology" size="20px" /> Think Tank
        </button>
        <button class="nav-item label-caps" :class="{ active: panel === 'history' }" @click="openPanel('history')">
          <q-icon name="history" size="20px" /> Session History
          <span v-if="history.length" class="nav-badge">{{ history.length }}</span>
        </button>
        <button class="nav-item label-caps" :class="{ active: panel === 'config' }" @click="openPanel('config')">
          <q-icon name="settings_ethernet" size="20px" /> YAML Config
        </button>
        <button class="nav-item label-caps" :class="{ active: panel === 'settings' }" @click="openPanel('settings')">
          <q-icon name="settings" size="20px" /> Global Settings
        </button>
      </nav>

      <div class="sys-status">
        <span class="label-caps">System Status</span>
        <span class="sys-dot-wrap font-mono">
          <span class="dot" :class="onlineClass"></span>
          {{ online === null ? 'CHECKING' : online ? 'ONLINE' : 'OFFLINE' }}
        </span>
      </div>
    </aside>

    <!-- ===== Top bar ===== -->
    <header class="topbar">
      <div class="topbar-left">
        <span class="brand-tag label-caps">Council of Personas</span>
        <nav class="tabs">
          <button class="tab" :class="{ active: panel === null }" @click="goHome">Project View</button>
          <button class="tab" :class="{ active: panel === 'settings' }" @click="openPanel('settings')">Metrics</button>
          <button class="tab" :class="{ active: panel === 'history' }" @click="openPanel('history')">Archives</button>
        </nav>
      </div>
      <div class="topbar-right">
        <button
          class="pr-toggle"
          :class="{ on: peerReviewOn }"
          :disabled="running"
          @click="peerReviewOn = !peerReviewOn"
          :title="`Peer review ${peerReviewOn ? 'on' : 'off'}`"
        >
          <span class="label-caps">Peer Review</span>
          <span class="switch"><span class="knob"></span></span>
        </button>
        <span class="model-tag font-mono">{{ modelTag }}</span>
      </div>
    </header>

    <!-- ===== Main stage ===== -->
    <main class="stage">
      <!-- Pinned Chairman synthesis -->
      <section class="hero glass-panel accent-blue">
        <div class="hero-inner">
          <div class="hero-head">
            <span class="dot pulse"></span>
            <span class="label-caps hero-title">The Chairman • Final Synthesis</span>
            <span class="hero-stage font-mono">{{ stageLabel }}</span>
          </div>

          <div v-if="fatal" class="hero-fatal font-mono">
            <q-icon name="error" /> {{ fatal }}
          </div>

          <div v-else-if="!hasRun" class="hero-idle font-mono">
            <span class="blinking-cursor">Awaiting input for Council deliberation. Initiate query below…</span>
          </div>

          <div v-else class="hero-body">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="chairman.content" class="synthesis" v-html="synthesisHtml"></div>
            <div v-else class="hero-idle font-mono">
              <span class="blinking-cursor">{{ stage === 'chairman' ? 'Synthesizing the council’s positions…' : 'Council in deliberation…' }}</span>
            </div>
          </div>
        </div>
        <div class="hero-accent-border"></div>
      </section>

      <!-- Scrollable chamber -->
      <div class="chamber">
        <!-- Command input -->
        <div class="cmd">
          <q-icon name="terminal" class="cmd-icon" />
          <input
            v-model="question"
            class="cmd-input font-mono"
            :disabled="running"
            placeholder="Enter directive for Council debate…"
            @keydown.enter="submit"
          />
          <button class="cmd-send label-caps" :disabled="!question.trim() || running" @click="submit">
            <q-spinner v-if="running" size="16px" />
            <template v-else><q-icon name="gavel" size="16px" /> Convene</template>
          </button>
        </div>

        <!-- Persona grid -->
        <div v-if="members.length" class="grid">
          <article
            v-for="m in members"
            :key="m.id"
            class="card glass-panel"
            :class="[`accent-${m.accent}`, { streaming: m.status === 'streaming', errored: m.status === 'error' }]"
          >
            <div class="card-topbar"></div>
            <header class="card-head">
              <div class="who">
                <div class="chip"><q-icon :name="m.icon" size="18px" /></div>
                <div>
                  <div class="role label-caps">{{ m.name }}</div>
                  <div class="tagline">{{ m.tagline }}</div>
                </div>
              </div>
              <div class="status">
                <span class="stat font-mono">{{ memberStatus(m) }}</span>
                <span class="dot" :class="dotClass(m)"></span>
              </div>
            </header>

            <div class="out font-mono">
              <span v-if="m.status === 'error'" class="err">&gt; ERROR: {{ m.error }}</span>
              <template v-else-if="m.answer">{{ m.answer }}</template>
              <span v-else class="muted blinking-cursor">&gt; {{ awaitingText(m) }}</span>
            </div>

            <!-- Peer critique -->
            <div v-if="m.reviewStatus !== 'skipped' && (m.review || m.ranking.length)" class="critique">
              <div class="critique-head label-caps">
                <q-icon name="rate_review" size="14px" /> Critique of peers
                <span v-if="m.ranking.length" class="ranks">
                  <span v-for="(l, i) in m.ranking" :key="l" class="rank-pill font-mono">{{ i + 1 }}·{{ shortLabel(l) }}</span>
                </span>
              </div>
              <div class="critique-body font-mono">{{ m.review }}</div>
            </div>
          </article>
        </div>

        <!-- Peer ranking tally -->
        <section v-if="tally.length" class="rankings">
          <div class="rankings-head">
            <span class="label-caps">Peer Review Rankings</span>
            <span class="font-mono nodes">{{ respondedCount }} nodes responded</span>
          </div>
          <div
            v-for="(row, i) in tally"
            :key="row.label"
            class="rank-row glass-panel"
            :class="`accent-${accentForLabel(row.label)}`"
          >
            <div class="rank-num font-head">{{ i + 1 }}</div>
            <div class="rank-name label-caps">{{ row.name }}</div>
            <div class="rank-bar"><span :style="{ width: barWidth(row.points) }"></span></div>
            <div class="rank-meta font-mono">{{ row.points }} pts · {{ row.appearances }} ballots</div>
          </div>
        </section>

        <div class="stage-spacer"></div>
      </div>
    </main>

    <!-- ===== Slide-over panels (sidebar nav targets) ===== -->
    <q-dialog v-model="panelOpen" position="right" seamless>
      <div class="panel glass-panel">
        <!-- Session History / Archives -->
        <template v-if="panel === 'history'">
          <header class="panel-head">
            <span class="label-caps"><q-icon name="history" size="18px" /> Session History</span>
            <q-btn flat dense round icon="close" v-close-popup />
          </header>
          <div class="panel-body">
            <div v-if="!history.length" class="panel-empty font-mono">
              No runs yet this session. Convene the council and they'll appear here.
            </div>
            <div v-for="h in history" :key="h.id" class="hist-item">
              <button class="hist-q label-caps" @click="toggleHist(h.id)">
                <q-icon :name="expandedHist === h.id ? 'expand_less' : 'expand_more'" size="16px" />
                <span>{{ h.question }}</span>
              </button>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-if="expandedHist === h.id" class="hist-synth synthesis" v-html="renderMarkdown(h.chairman)"></div>
            </div>
          </div>
        </template>

        <!-- YAML Config -->
        <template v-else-if="panel === 'config'">
          <header class="panel-head">
            <span class="label-caps"><q-icon name="settings_ethernet" size="18px" /> Council Config</span>
            <q-btn flat dense round icon="close" v-close-popup />
          </header>
          <div class="panel-body">
            <div v-if="!config" class="panel-empty font-mono">Loading…</div>
            <template v-else>
              <p class="panel-note font-mono">
                Read-only. Edit <code>council.yaml</code> and re-ask — changes apply with no restart.
              </p>
              <div
                v-for="p in config.council"
                :key="p.name"
                class="cfg-row"
                :class="`accent-${p.accent || 'blue'}`"
              >
                <span class="dot solid"></span>
                <div class="cfg-main">
                  <div class="role label-caps">{{ p.name }}</div>
                  <div class="cfg-sub font-mono">
                    {{ p.tagline || '—' }} · {{ p.model || config.default_model }}<span v-if="p.temperature != null"> · temp {{ p.temperature }}</span>
                  </div>
                </div>
              </div>
              <div class="cfg-row accent-blue">
                <span class="dot solid"></span>
                <div class="cfg-main">
                  <div class="role label-caps">{{ config.chairman.name }}</div>
                  <div class="cfg-sub font-mono">
                    Chairman · {{ config.chairman.model || config.default_model }}<span v-if="config.chairman.temperature != null"> · temp {{ config.chairman.temperature }}</span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </template>

        <!-- Global Settings / Metrics -->
        <template v-else-if="panel === 'settings'">
          <header class="panel-head">
            <span class="label-caps"><q-icon name="settings" size="18px" /> Global Settings</span>
            <q-btn flat dense round icon="close" v-close-popup />
          </header>
          <div class="panel-body">
            <div v-if="!config" class="panel-empty font-mono">Loading…</div>
            <dl v-else class="settings-list font-mono">
              <div><dt>Endpoint</dt><dd>{{ config.endpoint || '—' }}</dd></div>
              <div><dt>Council model · medium</dt><dd>{{ config.default_model || '—' }}</dd></div>
              <div><dt>Peer review · fast</dt><dd>{{ config.settings.review_model || config.default_model }}</dd></div>
              <div><dt>Chairman · hard</dt><dd>{{ config.chairman.model || config.default_model }}</dd></div>
              <div><dt>Peer review default</dt><dd>{{ config.settings.peer_review ? 'on' : 'off' }}</dd></div>
              <div><dt>Council temperature</dt><dd>{{ config.settings.council_temperature }}</dd></div>
              <div><dt>Chairman temperature</dt><dd>{{ config.settings.chairman_temperature }}</dd></div>
            </dl>
          </div>
        </template>
      </div>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useCouncil, type MemberState, type Accent } from '@/composables/useCouncil';
import { renderMarkdown } from '@/composables/markdown';

const {
  members, chairman, tally, stage, running, fatal, online,
  ask, reset, checkHealth,
} = useCouncil();

const question = ref('');
const peerReviewOn = ref(true);
const modelTag = ref('');

onMounted(async () => {
  await checkHealth();
  try {
    const j = await (await fetch('/api/health')).json();
    if (j?.model) modelTag.value = j.model;
  } catch { /* ignore */ }
});

// ---- Sidebar nav: slide-over panels --------------------------------------
type Panel = 'history' | 'config' | 'settings';
const panel = ref<Panel | null>(null);
const panelOpen = computed({
  get: () => panel.value !== null,
  set: (v: boolean) => { if (!v) panel.value = null; },
});
const config = ref<any>(null);

async function ensureConfig() {
  if (config.value) return;
  try {
    config.value = await (await fetch('/api/config')).json();
  } catch { /* leave null → shows Loading… */ }
}
function openPanel(p: Panel) {
  panel.value = p;
  if (p === 'config' || p === 'settings') void ensureConfig();
}
function goHome() {
  panel.value = null;
}

// ---- Session history (in-memory, this session only) ----------------------
interface HistEntry { id: number; question: string; chairman: string }
const history = ref<HistEntry[]>([]);
const expandedHist = ref<number | null>(null);
const lastAsked = ref('');
let histSeq = 0;

watch(running, (now, prev) => {
  // A run just finished — snapshot it for the history panel.
  if (prev && !now && chairman.content && lastAsked.value) {
    history.value.unshift({ id: ++histSeq, question: lastAsked.value, chairman: chairman.content });
  }
});
function toggleHist(id: number) {
  expandedHist.value = expandedHist.value === id ? null : id;
}

const hasRun = computed(() => members.length > 0 || !!chairman.content);
const respondedCount = computed(() => members.filter((m) => m.status === 'done').length);
const synthesisHtml = computed(() => renderMarkdown(chairman.content));

const stageLabel = computed(() => {
  if (fatal.value) return 'ERROR';
  switch (stage.value) {
    case 'fanout': return 'STAGE 1 · FAN-OUT';
    case 'review': return 'STAGE 2 · PEER REVIEW';
    case 'chairman': return 'STAGE 3 · SYNTHESIS';
    case 'done': return 'COMPLETE';
    default: return 'IDLE';
  }
});

const onlineClass = computed(() =>
  online.value === null ? 'pulse blue' : online.value ? 'green' : 'red',
);

const maxPoints = computed(() => tally.value.reduce((mx, r) => Math.max(mx, r.points), 0));
function barWidth(points: number): string {
  return maxPoints.value ? `${Math.round((points / maxPoints.value) * 100)}%` : '0%';
}

function accentForLabel(label: string): Accent {
  return members.find((m) => m.label === label)?.accent ?? 'blue';
}
function shortLabel(label: string): string {
  return label.replace('Advisor ', '');
}

function memberStatus(m: MemberState): string {
  if (m.status === 'error') return 'Error';
  if (m.status === 'streaming') return 'Streaming';
  if (m.status === 'done') {
    if (m.reviewStatus === 'streaming') return 'Critiquing';
    if (m.reviewStatus === 'done') return 'Reviewed';
    return 'Complete';
  }
  return 'Standby';
}
function dotClass(m: MemberState): string {
  if (m.status === 'error') return 'red';
  if (m.status === 'streaming' || m.reviewStatus === 'streaming') return 'pulse';
  if (m.status === 'done') return 'solid';
  return 'dim';
}
function awaitingText(m: MemberState): string {
  return m.status === 'pending' ? 'Standby — awaiting directive' : 'Initializing…';
}

function submit() {
  const q = question.value.trim();
  if (q && !running.value) {
    lastAsked.value = q;
    panel.value = null; // return to the live view when a new run starts
    void ask(q, { peerReview: peerReviewOn.value });
  }
}
function newSession() {
  if (running.value) return;
  reset();
  question.value = '';
}
</script>

<style scoped>
.cop {
  min-height: 100vh;
  background: var(--c-bg);
}

/* ---------- Sidebar ---------- */
.sidebar {
  position: fixed;
  left: 0; top: 0; bottom: 0;
  width: var(--sidebar-w);
  padding: var(--pad);
  background: var(--c-surface-lowest);
  border-right: 1px solid var(--c-outline-variant);
  display: flex;
  flex-direction: column;
  z-index: 50;
}
.brand { margin-bottom: 28px; }
.brand-title { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.brand-sub { font-size: 13px; color: var(--c-on-surface-variant); }
.new-session {
  width: 100%;
  background: var(--c-primary);
  color: var(--c-on-primary);
  border: none; border-radius: 6px;
  padding: 12px; margin-bottom: 28px;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  cursor: pointer; transition: filter 0.15s;
}
.new-session:hover:not(:disabled) { filter: brightness(1.1); }
.new-session:disabled { opacity: 0.5; cursor: not-allowed; }
.nav { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.nav-item {
  display: flex; align-items: center; gap: 12px;
  width: 100%; text-align: left;
  padding: 11px; border-radius: 6px;
  background: none; border: none; border-right: 2px solid transparent;
  color: var(--c-on-surface-variant); cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: var(--c-surface-high); color: var(--c-on-surface); }
.nav-item.active {
  color: var(--c-primary);
  background: rgba(34, 42, 61, 0.5);
  border-right-color: var(--c-primary);
}
.nav-badge {
  margin-left: auto; font-family: var(--font-mono); font-size: 10px;
  background: var(--c-primary-container); color: var(--c-primary);
  border-radius: 999px; padding: 1px 7px;
}
.sys-status {
  display: flex; justify-content: space-between; align-items: center;
  padding-top: 16px; margin-top: 8px;
  border-top: 1px solid var(--c-outline-variant);
  color: var(--c-on-surface-variant); font-size: 10px;
}
.sys-dot-wrap { display: flex; align-items: center; gap: 6px; font-size: 10px; }

/* ---------- Top bar ---------- */
.topbar {
  position: fixed;
  top: 0; right: 0; left: var(--sidebar-w);
  height: 64px;
  padding: 0 var(--pad);
  display: flex; align-items: center; justify-content: space-between;
  background: rgba(11, 19, 38, 0.8);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(69, 70, 81, 0.3);
  z-index: 40;
}
.topbar-left { display: flex; align-items: center; gap: 28px; }
.brand-tag { color: var(--c-primary); letter-spacing: 0.12em; }
.tabs { display: flex; gap: 20px; }
.tab {
  font-size: 14px; color: var(--c-on-surface-variant);
  padding: 0 0 2px; cursor: pointer;
  background: none; border: none; border-bottom: 2px solid transparent;
  transition: color 0.15s;
}
.tab:hover { color: var(--c-primary); }
.tab.active { color: var(--c-on-surface); font-weight: 700; border-bottom-color: var(--c-primary); }
.topbar-right { display: flex; align-items: center; gap: 16px; }
.pr-toggle {
  display: flex; align-items: center; gap: 8px;
  background: transparent; cursor: pointer;
  border: 1px solid var(--c-outline-variant); border-radius: 6px;
  padding: 6px 12px; color: var(--c-on-surface-variant);
}
.pr-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.switch {
  width: 30px; height: 16px; border-radius: 999px;
  background: var(--c-surface-high); position: relative; transition: background 0.2s;
}
.pr-toggle.on .switch { background: var(--c-primary-container); }
.knob {
  position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 999px;
  background: var(--c-outline); transition: transform 0.2s, background 0.2s;
}
.pr-toggle.on .knob { transform: translateX(14px); background: var(--c-primary); }
.model-tag { font-size: 11px; color: var(--c-on-surface-variant); }

/* ---------- Stage ---------- */
.stage { margin-left: var(--sidebar-w); padding-top: 64px; min-height: 100vh; }

/* Pinned hero */
.hero {
  position: sticky; top: 64px; z-index: 20;
  border-bottom: 1px solid rgba(188, 195, 255, 0.3);
  padding: 20px var(--pad);
  max-height: 44vh; overflow-y: auto;
}
.hero-inner { max-width: var(--content-max); margin: 0 auto; }
.hero-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.hero-title { color: var(--c-primary); letter-spacing: 0.14em; }
.hero-stage { margin-left: auto; font-size: 11px; color: var(--c-on-surface-variant); }
.hero-idle { color: var(--c-on-surface-variant); font-size: 14px; padding: 18px 0; text-align: center; }
.hero-fatal { color: var(--c-red); font-size: 13px; }
.synthesis {
  word-break: break-word;
  font-family: var(--font-body); font-size: 15px; line-height: 1.6;
  color: var(--c-on-surface-variant);
}
.synthesis :deep(h3),
.synthesis :deep(h4),
.synthesis :deep(h5) {
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--c-primary);
  margin: 16px 0 6px;
}
.synthesis :deep(p) { margin: 0 0 10px; }
.synthesis :deep(strong) { color: var(--c-on-surface); font-weight: 600; }
.synthesis :deep(ul) { margin: 0 0 10px; padding-left: 20px; }
.synthesis :deep(li) { margin: 3px 0; }
.synthesis :deep(code) {
  font-family: var(--font-mono); font-size: 13px;
  background: var(--c-surface-high); padding: 1px 5px; border-radius: 4px;
}
.synthesis :deep(h3:first-child),
.synthesis :deep(p:first-child) { margin-top: 0; }
.hero-accent-border {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: linear-gradient(90deg, var(--c-primary-container), var(--c-primary), transparent);
  opacity: 0.6;
}

/* Chamber */
.chamber {
  padding: var(--pad);
  background: linear-gradient(to bottom, var(--c-bg), var(--c-surface-lowest));
}
.cmd {
  max-width: var(--content-max); margin: 0 auto 16px;
  display: flex; align-items: center; gap: 10px;
  background: var(--c-surface-low);
  border: 1px solid var(--c-outline-variant); border-radius: 8px;
  padding: 6px 6px 6px 14px; transition: border-color 0.2s;
}
.cmd:focus-within { border-color: var(--c-primary); box-shadow: 0 0 0 1px var(--c-primary); }
.cmd-icon { color: var(--c-outline); }
.cmd-input {
  flex: 1; background: transparent; border: none; outline: none;
  color: var(--c-on-surface); font-size: 14px; padding: 10px 0;
}
.cmd-input::placeholder { color: rgba(144, 144, 157, 0.7); }
.cmd-send {
  display: flex; align-items: center; gap: 6px;
  background: var(--c-primary); color: var(--c-on-primary);
  border: none; border-radius: 6px; padding: 10px 16px; cursor: pointer;
  transition: filter 0.15s;
}
.cmd-send:hover:not(:disabled) { filter: brightness(1.1); }
.cmd-send:disabled { opacity: 0.5; cursor: not-allowed; }

/* Persona grid */
.grid {
  max-width: var(--content-max); margin: 0 auto;
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;
}
.card {
  position: relative; border-radius: 8px; padding: 22px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  display: flex; flex-direction: column; min-height: 230px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.card.streaming { border-left: 2px solid var(--accent); box-shadow: 0 0 24px -8px var(--accent); }
.card.errored { border-color: color-mix(in srgb, var(--c-red) 50%, transparent); }
.card-topbar {
  position: absolute; top: 0; left: 0; right: 0; height: 2px;
  border-radius: 8px 8px 0 0;
  background: color-mix(in srgb, var(--accent) 45%, transparent);
}
.card-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
.who { display: flex; gap: 12px; align-items: center; }
.chip {
  width: 34px; height: 34px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent-bg);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--accent);
}
.role { color: var(--accent); letter-spacing: 0.06em; }
.tagline { font-size: 10px; color: var(--c-on-surface-variant); }
.status { display: flex; align-items: center; gap: 8px; }
.stat { font-size: 10px; color: color-mix(in srgb, var(--accent) 80%, white 20%); }
.out {
  flex: 1; background: rgba(6, 14, 32, 0.5);
  border: 1px solid rgba(69, 70, 81, 0.3); border-radius: 6px;
  padding: 14px; font-size: 13px; line-height: 1.55;
  color: var(--c-on-surface-variant);
  white-space: pre-wrap; word-break: break-word;
  max-height: 320px; overflow-y: auto;
}
.out .err { color: var(--c-red); }
.out .muted { color: var(--c-outline); }
.critique { margin-top: 12px; }
.critique-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  color: var(--c-on-surface-variant); margin-bottom: 8px;
}
.ranks { display: flex; gap: 4px; }
.rank-pill {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  background: var(--c-surface-high); color: var(--c-on-surface-variant);
}
.critique-body {
  font-size: 12px; line-height: 1.5; color: var(--c-on-surface-variant);
  white-space: pre-wrap; word-break: break-word;
  max-height: 160px; overflow-y: auto;
  padding: 10px; background: rgba(6, 14, 32, 0.4); border-radius: 6px;
}

/* Rankings */
.rankings { max-width: var(--content-max); margin: 28px auto 0; }
.rankings-head {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;
  color: var(--c-on-surface-variant);
}
.nodes { font-size: 12px; color: var(--c-outline); }
.rank-row {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 18px; margin-bottom: 10px;
  border: 1px solid var(--c-outline-variant); border-radius: 8px;
}
.rank-num { font-size: 18px; font-weight: 600; color: var(--accent); width: 22px; }
.rank-name { color: var(--accent); flex: 0 0 200px; }
.rank-bar { flex: 1; height: 8px; background: var(--c-surface-high); border-radius: 999px; overflow: hidden; }
.rank-bar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.4s; }
.rank-meta { font-size: 11px; color: var(--c-on-surface-variant); flex: 0 0 150px; text-align: right; }
.stage-spacer { height: 48px; }

/* Status dots */
.dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; background: var(--c-outline); }
.dot.dim { background: var(--c-outline); opacity: 0.5; }
.dot.solid { background: var(--accent, var(--c-primary)); }
.dot.red { background: var(--c-red); box-shadow: 0 0 8px var(--c-red); }
.dot.green { background: var(--positive, #36e0a6); box-shadow: 0 0 8px #36e0a6; }
.dot.blue { background: var(--c-primary); }
.dot.pulse { background: var(--accent, var(--c-primary)); box-shadow: 0 0 8px var(--accent, var(--c-primary)); animation: dotpulse 1.2s ease-in-out infinite; }
@keyframes dotpulse { 50% { opacity: 0.35; } }

/* Slide-over panels */
.panel {
  width: 460px; max-width: 92vw; height: 100vh;
  display: flex; flex-direction: column;
  background: var(--c-surface-low);
  border-left: 1px solid var(--c-outline-variant);
}
.panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 20px; border-bottom: 1px solid var(--c-outline-variant);
  color: var(--c-primary);
}
.panel-head .label-caps { display: flex; align-items: center; gap: 8px; }
.panel-body { padding: 18px 20px; overflow-y: auto; }
.panel-empty { color: var(--c-outline); font-size: 13px; line-height: 1.6; }
.panel-note {
  font-size: 11px; color: var(--c-on-surface-variant);
  margin: 0 0 14px; line-height: 1.5;
}
.panel-note code { background: var(--c-surface-high); padding: 1px 5px; border-radius: 4px; }

/* Config rows */
.cfg-row {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 14px; margin-bottom: 8px;
  background: rgba(6, 14, 32, 0.5);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-left: 2px solid var(--accent); border-radius: 6px;
}
.cfg-row .dot { margin-top: 5px; }
.cfg-row .role { color: var(--accent); }
.cfg-sub { font-size: 11px; color: var(--c-on-surface-variant); margin-top: 3px; }

/* Settings list */
.settings-list { font-size: 13px; }
.settings-list > div {
  display: flex; justify-content: space-between; gap: 16px;
  padding: 10px 0; border-bottom: 1px solid rgba(69, 70, 81, 0.3);
}
.settings-list dt { color: var(--c-on-surface-variant); }
.settings-list dd { margin: 0; color: var(--c-on-surface); text-align: right; }

/* History */
.hist-item { border-bottom: 1px solid rgba(69, 70, 81, 0.3); padding: 4px 0; }
.hist-q {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  background: none; border: none; cursor: pointer;
  color: var(--c-on-surface); padding: 10px 0; font-size: 12px;
}
.hist-q:hover { color: var(--c-primary); }
.hist-synth { font-size: 13px; padding: 4px 0 14px; }

/* Responsive */
@media (max-width: 950px) {
  .sidebar { display: none; }
  .topbar { left: 0; }
  .stage { margin-left: 0; }
  .grid { grid-template-columns: 1fr; }
}
</style>
