<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { rpc } from "../ipc.js";
import type { Profile, SyncPlan, ApplyResult } from "@db-mirror/core";

const profiles = ref<readonly Profile[]>([]);
const source = ref("");
const target = ref("");
const sourceDb = ref("");
const targetDb = ref("");
const sourceDbs = ref<string[]>([]);
const targetDbs = ref<string[]>([]);
const sourceDbsLoading = ref(false);
const targetDbsLoading = ref(false);
const sourceDbsError = ref<string | null>(null);
const targetDbsError = ref<string | null>(null);

const mode = ref<"diff" | "overwrite">("diff");
const includeSchema = ref(true);
const includeData = ref(true);
const include = ref("");
const exclude = ref("");

const plan = ref<SyncPlan | null>(null);
const applyResult = ref<ApplyResult | null>(null);
const busy = ref(false);
const applyBusy = ref(false);
const error = ref<string | null>(null);

type PendingAction = { kind: "apply"; dryRun: false } | { kind: "overwrite" };
const pendingAction = ref<PendingAction | null>(null);
const confirmInput = ref("");
const progressLog = ref<{ t: string; txt: string; kind: "info" | "ok" | "err" }[]>([]);
const logEl = ref<HTMLElement | null>(null);
const applyResultEl = ref<HTMLElement | null>(null);
const diffStart = ref<number>(0);
const diffElapsed = ref(0);
const activeTab = ref<"schema" | "data">("schema");
const selectedTable = ref<string | null>(null);

onMounted(() => { rpc.listProfiles().then(p => profiles.value = p); });

const sp = computed(() => profiles.value.find(p => p.id === source.value));
const tp = computed(() => profiles.value.find(p => p.id === target.value));

async function loadDatabases(profileId: string, side: "source" | "target") {
  if (side === "source") { sourceDbsLoading.value = true; sourceDbs.value = []; sourceDb.value = ""; sourceDbsError.value = null; }
  else { targetDbsLoading.value = true; targetDbs.value = []; targetDb.value = ""; targetDbsError.value = null; }
  try {
    const dbs = await rpc.listDatabases(profileId);
    const profile = profiles.value.find(p => p.id === profileId);
    if (side === "source") {
      sourceDbs.value = dbs;
      sourceDb.value = dbs.find(d => d === profile?.database) ?? dbs[0] ?? "";
    } else {
      targetDbs.value = dbs;
      targetDb.value = dbs.find(d => d === profile?.database) ?? dbs[0] ?? "";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (side === "source") { sourceDbs.value = []; sourceDbsError.value = msg; }
    else { targetDbs.value = []; targetDbsError.value = msg; }
  } finally {
    if (side === "source") sourceDbsLoading.value = false; else targetDbsLoading.value = false;
  }
}

watch(source, (id) => { if (id) loadDatabases(id, "source"); else { sourceDbs.value = []; sourceDb.value = ""; } });
watch(target, (id) => { if (id) loadDatabases(id, "target"); else { targetDbs.value = []; targetDb.value = ""; } });

function splitGlobs(s: string): string[] { return s.split(",").map(x => x.trim()).filter(Boolean); }

function pushLog(msg: string) {
  const now = new Date();
  const t = now.toTimeString().slice(0, 8) + "." + String(now.getMilliseconds()).padStart(3, "0");
  const kind: "info" | "ok" | "err" = msg.startsWith("✓") ? "ok" : msg.startsWith("✗") ? "err" : "info";
  progressLog.value.push({ t, txt: msg.replace(/^[✓✗]\s*/, ""), kind });
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
}

async function runDiff() {
  if (!source.value || !target.value) return;
  if (!sourceDb.value || !targetDb.value) { error.value = "Please select a database for source and target."; return; }
  busy.value = true; error.value = null; plan.value = null; applyResult.value = null;
  progressLog.value = []; diffStart.value = Date.now();

  const timer = setInterval(() => { diffElapsed.value = (Date.now() - diffStart.value) / 1000; }, 100);
  const unsubscribe = rpc.onDiffProgress(pushLog);

  try {
    plan.value = await rpc.diff({
      sourceProfileId: source.value, targetProfileId: target.value,
      sourceDb: sourceDb.value, targetDb: targetDb.value,
      schema: includeSchema.value, data: includeData.value,
      include: include.value ? splitGlobs(include.value) : [],
      exclude: exclude.value ? splitGlobs(exclude.value) : [],
    });
    if (plan.value) {
      const tbl = [...new Set([
        ...plan.value.schema.map((s: any) => s.object),
        ...plan.value.data.map((s: any) => s.table),
      ])][0];
      selectedTable.value = tbl ?? null;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    unsubscribe(); clearInterval(timer); busy.value = false;
  }
}

async function runApply(dryRun: boolean) {
  if (!plan.value || !target.value || !tp.value) return;
  const destructive = plan.value.schema.some((s: any) => s.destructive) || plan.value.data.some((s: any) => s.destructive);
  if (!dryRun && destructive) {
    confirmInput.value = "";
    pendingAction.value = { kind: "apply", dryRun: false };
    return;
  }
  await executeApply(dryRun);
}

async function executeApply(dryRun: boolean) {
  if (!plan.value || !target.value) return;
  pendingAction.value = null;
  applyBusy.value = true; busy.value = true; error.value = null; applyResult.value = null;
  const total = plan.value.schema.length + plan.value.data.length;
  pushLog(`${dryRun ? "Dry-run" : "Applying"} plan — ${total} statement(s)…`);
  const unsubApply = rpc.onApplyProgress(pushLog);
  try {
    const result = await rpc.apply({ targetProfileId: target.value, plan: JSON.parse(JSON.stringify(plan.value)), dryRun });
    applyResult.value = result;
    if (result.errors.length) {
      pushLog(`✗ ${dryRun ? "Dry-run" : "Apply"} finished with ${result.errors.length} error(s)`);
    } else {
      pushLog(`✓ ${dryRun ? "Dry-run" : "Apply"} complete — ${dryRun ? result.skipped : result.executed} statement(s) ${dryRun ? "skipped" : "executed"}`);
    }
    await nextTick();
    applyResultEl.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    pushLog(`✗ ${msg}`);
  } finally {
    unsubApply();
    applyBusy.value = false; busy.value = false;
  }
}

async function runOverwrite() {
  if (!source.value || !target.value || !tp.value) return;
  confirmInput.value = "";
  pendingAction.value = { kind: "overwrite" };
}

async function executeOverwrite() {
  if (!source.value || !target.value) return;
  pendingAction.value = null;
  busy.value = true; error.value = null;
  pushLog("Full overwrite started…");
  try {
    const tables = include.value ? splitGlobs(include.value) : undefined;
    await rpc.overwrite({ sourceProfileId: source.value, targetProfileId: target.value, tables });
    applyResult.value = { executed: -1, skipped: 0, errors: [] };
    pushLog("✓ Overwrite complete");
    await nextTick();
    applyResultEl.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    pushLog(`✗ ${msg}`);
  } finally { busy.value = false; }
}

function confirmActionName() {
  if (!pendingAction.value || !tp.value) return "";
  return tp.value.name;
}

async function submitConfirm() {
  if (!pendingAction.value || !tp.value) return;
  if (confirmInput.value !== tp.value.name) return;
  const action = pendingAction.value;
  if (action.kind === "apply") await executeApply(false);
  else await executeOverwrite();
}

const schemaStmts = computed(() => plan.value?.schema ?? []);
const dataStmts = computed(() => plan.value?.data ?? []);
const destructiveCount = computed(() =>
  schemaStmts.value.filter((s: any) => s.destructive).length +
  dataStmts.value.filter((s: any) => s.destructive).length
);

const tables = computed(() => {
  if (!plan.value) return [];
  const map = new Map<string, { add: number; edit: number; del: number; destructive: boolean }>();
  for (const s of schemaStmts.value as any[]) {
    const t = s.object;
    const m = map.get(t) ?? { add: 0, edit: 0, del: 0, destructive: false };
    if (s.kind === "create") m.add++; else if (s.kind === "drop") m.del++; else m.edit++;
    if (s.destructive) m.destructive = true;
    map.set(t, m);
  }
  for (const s of dataStmts.value as any[]) {
    const t = s.table;
    const m = map.get(t) ?? { add: 0, edit: 0, del: 0, destructive: false };
    if (s.kind === "insert") m.add++; else if (s.kind === "delete") m.del++; else m.edit++;
    if (s.destructive) m.destructive = true;
    map.set(t, m);
  }
  return Array.from(map.entries()).map(([name, v]) => ({ name, ...v }));
});

const filteredStmts = computed(() => {
  const list: any[] = activeTab.value === "schema" ? [...schemaStmts.value] : [...dataStmts.value];
  if (!selectedTable.value) return list;
  return list.filter(s => (s.object ?? s.table) === selectedTable.value);
});

async function copyLog() {
  const text = progressLog.value.map(l => `${l.t}  ${l.txt}`).join("\n");
  await navigator.clipboard.writeText(text);
}
async function copySql() {
  const list = (activeTab.value === "schema" ? schemaStmts.value : dataStmts.value) as any[];
  const text = list.map(s => `-- ${s.kind} ${s.object ?? s.table}${s.destructive ? " (DESTRUCTIVE)" : ""}\n${s.sql};`).join("\n\n");
  await navigator.clipboard.writeText(text);
}
</script>

<template>
  <div class="workbench">
    <!-- Left rail -->
    <aside class="rail">
      <div class="rail-head">
        <span>Recent mirrors</span>
        <div class="grow" />
        <button class="btn ghost sm icon" title="New"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3v10M3 8h10"/></svg></button>
      </div>
      <div class="rail-body">
        <div class="empty-rail">
          <div class="muted" style="font-size:11.5px; padding: 20px 10px; text-align:center">
            Your recent diffs will show up here.
          </div>
        </div>
      </div>
      <div class="rail-foot">
        <div class="row" style="gap:6px; margin-bottom:4px">
          <span class="live-dot" /><span>IPC connected</span>
        </div>
        <div class="mono muted-2">main.ts · secure channel</div>
      </div>
    </aside>

    <main class="main">
      <!-- Control bar -->
      <section class="controls">
        <div class="src-row">
          <div class="src-col">
            <div class="src-label">
              <span>Source</span>
              <span v-if="sp" class="pill dot ok">connected</span>
            </div>
            <div class="src-selects">
              <select class="select" v-model="source" :disabled="busy">
                <option value="">— pick profile —</option>
                <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <div class="db-wrap">
                <select v-if="sourceDbs.length" class="select mono" v-model="sourceDb" :disabled="busy">
                  <option value="">— db —</option>
                  <option v-for="db in sourceDbs" :key="db" :value="db">{{ db }}</option>
                </select>
                <input v-else class="input mono" v-model="sourceDb" placeholder="schema" :disabled="!source || busy" />
                <span v-if="sourceDbsLoading" class="spinner sm db-sp" />
                <button v-else-if="source && !sourceDbsLoading" class="btn ghost sm db-retry" :disabled="busy" @click="loadDatabases(source, 'source')" title="Reload databases">
                  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 1 0 1.5-4M2 2v4h4"/></svg>
                </button>
              </div>
            </div>
            <div v-if="sourceDbsError" class="db-err" :title="sourceDbsError">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 7v3M8 5v.01"/></svg>
              Connection failed — enter schema name manually
            </div>
          </div>

          <svg class="arrow" viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>

          <div class="src-col">
            <div class="src-label">
              <span>Target</span>
              <span v-if="tp" class="pill dot ok">connected</span>
            </div>
            <div class="src-selects">
              <select class="select" v-model="target" :disabled="busy">
                <option value="">— pick profile —</option>
                <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <div class="db-wrap">
                <select v-if="targetDbs.length" class="select mono" v-model="targetDb" :disabled="busy">
                  <option value="">— db —</option>
                  <option v-for="db in targetDbs" :key="db" :value="db">{{ db }}</option>
                </select>
                <input v-else class="input mono" v-model="targetDb" placeholder="schema" :disabled="!target || busy" />
                <span v-if="targetDbsLoading" class="spinner sm db-sp" />
                <button v-else-if="target && !targetDbsLoading" class="btn ghost sm db-retry" :disabled="busy" @click="loadDatabases(target, 'target')" title="Reload databases">
                  <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 1 0 1.5-4M2 2v4h4"/></svg>
                </button>
              </div>
            </div>
            <div v-if="targetDbsError" class="db-err" :title="targetDbsError">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 7v3M8 5v.01"/></svg>
              Connection failed — enter schema name manually
            </div>
          </div>

          <div class="mode-col">
            <div class="src-label"><span>Mode</span></div>
            <div class="seg" style="padding:3px">
              <button :class="{ on: mode === 'diff' }" @click="mode = 'diff'">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2v12M11 2v12M3 4l2-2 2 2M9 12l2 2 2-2"/></svg>
                Diff &amp; Sync
              </button>
              <button :class="{ on: mode === 'overwrite' }" @click="mode = 'overwrite'">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M9 1.5L3 9h4l-1 5.5L13 7H9z"/></svg>
                Full overwrite
              </button>
            </div>
          </div>
        </div>

        <div class="opts-row" v-if="mode === 'diff'">
          <div class="opts-checks">
            <label class="check"><input type="checkbox" v-model="includeSchema" :disabled="busy" /><span class="box" />Schema</label>
            <label class="check"><input type="checkbox" v-model="includeData" :disabled="busy" /><span class="box" />Data</label>
          </div>
          <div class="divider-v" />
          <div class="opts-filters">
            <div>
              <div class="field-label"><span class="ok-text">⊕</span> Include tables</div>
              <input class="input mono" v-model="include" placeholder="app_*, orders, order_items" :disabled="busy" />
            </div>
            <div>
              <div class="field-label"><span class="danger-text">⊖</span> Exclude tables</div>
              <input class="input mono" v-model="exclude" placeholder="sessions, cache_*, _temp_*" :disabled="busy" />
            </div>
          </div>
          <div class="actions">
            <button class="btn lg primary" @click="runDiff" :disabled="busy || !source || !target || !sourceDb || !targetDb">
              <span v-if="busy" class="spinner dark" />
              <svg v-else viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2v12M11 2v12M3 4l2-2 2 2M9 12l2 2 2-2"/></svg>
              {{ busy ? "Diffing…" : "Compute diff" }}
            </button>
            <button class="btn lg" @click="runApply(true)" :disabled="busy || !plan">
              <span v-if="applyBusy" class="spinner sm" />
              Dry-run
            </button>
            <button class="btn lg danger solid" @click="runApply(false)" :disabled="busy || !plan">
              <span v-if="applyBusy" class="spinner dark sm" />
              Apply
            </button>
          </div>
        </div>

        <div class="opts-row" v-else>
          <div class="muted" style="flex:1; font-size:12.5px">
            <strong class="danger-text">Full overwrite</strong> will drop and recreate the target schema from source. All target data will be replaced.
          </div>
          <button class="btn lg danger solid" @click="runOverwrite" :disabled="busy || !source || !target">
            Overwrite target
          </button>
        </div>

        <!-- Destructive confirmation -->
        <div v-if="pendingAction" class="confirm-banner">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l6 12H2z"/><path d="M8 7v3M8 11.5v.01"/></svg>
          <div class="confirm-body">
            <div class="confirm-title">
              {{ pendingAction.kind === 'overwrite' ? 'Full overwrite — all target data will be replaced.' : 'Destructive changes detected.' }}
              Type <strong class="mono">{{ confirmActionName() }}</strong> to confirm.
            </div>
            <div class="confirm-row">
              <input
                class="input mono confirm-input"
                v-model="confirmInput"
                :placeholder="confirmActionName()"
                @keydown.enter="submitConfirm"
                @keydown.esc="pendingAction = null"
                autofocus
              />
              <button class="btn danger solid" :disabled="confirmInput !== confirmActionName()" @click="submitConfirm">
                {{ pendingAction.kind === 'overwrite' ? 'Overwrite' : 'Apply' }}
              </button>
              <button class="btn ghost" @click="pendingAction = null">Cancel</button>
            </div>
          </div>
        </div>

        <div v-if="error" class="err-inline">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5v.01"/></svg>
          {{ error }}
        </div>
      </section>

      <!-- Body -->
      <section class="body">
        <!-- Empty state -->
        <div v-if="!busy && !plan && !applyResult && !progressLog.length" class="empty-body">
          <div class="empty-card">
            <div class="empty-title">No plan computed yet</div>
            <div class="empty-sub">Pick a source and target above, then compute a diff. We'll show every change before anything is written.</div>
            <div class="empty-hint"><span class="kbd">⌘</span><span class="kbd">↵</span><span>to compute</span></div>
          </div>
        </div>

        <!-- Log -->
        <div v-if="busy || progressLog.length" class="panel">
          <header class="panel-head">
            <span v-if="busy" class="spinner" />
            <span v-else class="glyph ok" />
            <span>{{ busy ? "Computing diff…" : "Diff complete" }}</span>
            <span class="mono muted" style="font-weight:400; font-size:11.5px">· {{ diffElapsed.toFixed(2) }}s</span>
            <div class="grow" />
            <button class="btn sm ghost" @click="copyLog"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>Copy log</button>
          </header>
          <div ref="logEl" class="log">
            <div v-for="(l, i) in progressLog" :key="i" class="log-row" :class="l.kind">
              <span class="log-t">{{ l.t }}</span>
              <span class="log-dot">{{ l.kind === "ok" ? "✓" : l.kind === "err" ? "✗" : "·" }}</span>
              <span class="log-txt">{{ l.txt }}</span>
            </div>
            <div v-if="busy" class="log-row current">
              <span class="log-t"></span>
              <span class="log-dot"><span class="spinner sm" /></span>
              <span class="log-txt">Working…</span>
            </div>
          </div>
        </div>

        <!-- Plan -->
        <div v-if="plan" class="panel">
          <header class="panel-head">
            <span>Plan</span>
            <span class="mono muted" style="font-weight:400; font-size:11.5px">{{ sourceDb }} → {{ targetDb }}</span>
            <div class="grow" />
            <div class="stats">
              <div class="stat"><span>Schema</span><span class="mono num" style="color:var(--accent)">{{ schemaStmts.length }}</span></div>
              <div class="stat"><span>Data</span><span class="mono num">{{ dataStmts.length.toLocaleString() }}</span></div>
              <div class="stat"><span>Destructive</span><span class="mono num danger-text">{{ destructiveCount }}</span></div>
            </div>
          </header>

          <div class="plan-grid">
            <div class="tables">
              <div class="tables-head">Tables ({{ tables.length }})</div>
              <div
                v-for="t in tables" :key="t.name"
                class="tbl-row"
                :class="{ sel: selectedTable === t.name }"
                @click="selectedTable = t.name"
              >
                <div class="row" style="gap:6px">
                  <span class="mono">{{ t.name }}</span>
                  <span v-if="t.destructive" class="pill danger" style="font-size:9.5px; height:14px; padding:0 5px">DESTRUCTIVE</span>
                </div>
                <div class="tbl-counts mono">
                  <span v-if="t.add" class="ok-text">+{{ t.add }}</span>
                  <span v-if="t.edit" style="color:oklch(0.82 0.14 82)">~{{ t.edit }}</span>
                  <span v-if="t.del" class="danger-text">-{{ t.del }}</span>
                </div>
              </div>
              <div v-if="!tables.length" class="muted" style="padding:14px; font-size:12px">No changes detected.</div>
            </div>

            <div class="stmts">
              <div class="stmts-tabs">
                <button :class="['btn', 'sm', activeTab === 'schema' ? 'primary' : 'ghost']" @click="activeTab = 'schema'">
                  Schema <span class="pill" style="margin-left:4px; font-size:10px; height:15px; padding:0 5px">{{ schemaStmts.length }}</span>
                </button>
                <button :class="['btn', 'sm', activeTab === 'data' ? 'primary' : 'ghost']" @click="activeTab = 'data'">
                  Data <span class="pill" style="margin-left:4px; font-size:10px; height:15px; padding:0 5px">{{ dataStmts.length.toLocaleString() }}</span>
                </button>
                <div class="grow" />
                <span v-if="selectedTable" class="muted" style="font-size:11.5px; margin-right:8px">
                  Viewing: <span class="mono" style="color:var(--text-dim)">{{ selectedTable }}</span>
                  <button class="btn ghost sm" style="margin-left:6px; height:20px; padding:0 6px; font-size:11px" @click="selectedTable = null">clear</button>
                </span>
                <button class="btn sm ghost" @click="copySql">
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>
                  Copy SQL
                </button>
              </div>

              <div class="stmts-body">
                <div
                  v-for="(s, i) in (filteredStmts as any[]).slice(0, 500)" :key="i"
                  class="stmt"
                  :class="{ destructive: s.destructive }"
                >
                  <div class="stmt-head">
                    <span class="stmt-badge" :class="{ destructive: s.destructive }">{{ (s.kind ?? '').toUpperCase() }}</span>
                    <span v-if="s.destructive" class="pill danger" style="font-size:9.5px; height:15px">DESTRUCTIVE</span>
                    <span class="mono muted" style="font-size:11px">{{ s.object ?? s.table }}</span>
                    <div class="grow" />
                  </div>
                  <pre class="code">{{ s.sql }};</pre>
                </div>
                <div v-if="(activeTab === 'data' && dataStmts.length > 500)" class="muted" style="padding:12px; font-size:12px">
                  … {{ (dataStmts.length - 500).toLocaleString() }} more statements hidden for performance
                </div>
                <div v-if="!filteredStmts.length" class="muted" style="padding:24px; text-align:center; font-size:12.5px">
                  No {{ activeTab }} statements{{ selectedTable ? ` for ${selectedTable}` : "" }}.
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Apply result -->
        <div v-if="applyResult" ref="applyResultEl" class="panel">
          <header class="panel-head">
            <span v-if="applyResult.errors.length" class="i" style="color:var(--danger)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l8 8M12 4l-8 8"/></svg></span>
            <span v-else class="i" style="color:var(--ok)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg></span>
            <span>{{ applyResult.errors.length ? "Apply completed with errors" : "Apply complete" }}</span>
          </header>
          <div class="result-grid">
            <div class="res-card">
              <div class="res-label">Executed</div>
              <div class="res-val mono num" style="color:var(--ok)">{{ applyResult.executed === -1 ? "—" : applyResult.executed }}</div>
            </div>
            <div class="res-card">
              <div class="res-label">Skipped</div>
              <div class="res-val mono num">{{ applyResult.skipped }}</div>
            </div>
            <div class="res-card">
              <div class="res-label">Errors</div>
              <div class="res-val mono num" :style="{ color: applyResult.errors.length ? 'var(--danger)' : 'var(--text)' }">{{ applyResult.errors.length }}</div>
            </div>
          </div>
          <details v-if="applyResult.errors.length" class="err-details" open>
            <summary>{{ applyResult.errors.length }} errors · show details</summary>
            <div class="err-body">
              <div v-for="(e, i) in applyResult.errors" :key="i" class="err-row">
                <div class="danger-text mono">[{{ i + 1 }}] {{ e.error }}</div>
                <div class="muted mono">{{ e.sql.slice(0, 200) }}{{ e.sql.length > 200 ? "…" : "" }}</div>
              </div>
            </div>
          </details>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.workbench { display: grid; grid-template-columns: 240px 1fr; height: 100%; overflow: hidden; }

/* Rail */
.rail { border-right: 1px solid var(--hairline); background: var(--bg-2); display: flex; flex-direction: column; min-height: 0; }
.rail-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.rail-body { flex: 1; overflow: auto; padding: 0 8px 8px; }
.rail-foot { padding: 10px; border-top: 1px solid var(--hairline); font-size: 11px; color: var(--muted); }
.muted-2 { color: var(--muted-2); font-size: 10.5px; }

/* Main */
.main { display: flex; flex-direction: column; min-height: 0; }
.controls { padding: 14px; border-bottom: 1px solid var(--hairline); background: var(--bg-2); }
.src-row { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap; }
.src-col { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 6px; }
.src-label { display: flex; align-items: center; gap: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; }
.src-selects { display: grid; grid-template-columns: 1.3fr 1fr; gap: 6px; }
.db-wrap { position: relative; }
.db-sp { position: absolute; right: 26px; top: 10px; }
.db-retry { position: absolute; right: 24px; top: 3px; height: 24px; width: 24px; padding: 0; justify-content: center; }
.db-err { font-size: 11px; color: oklch(0.85 0.18 22); display: flex; gap: 5px; align-items: center; margin-top: 4px; }
.arrow { color: var(--muted); padding-bottom: 6px; flex-shrink: 0; }
.mode-col { flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; }

.opts-row {
  margin-top: 14px; padding-top: 14px;
  border-top: 1px dashed var(--hairline);
  display: grid; grid-template-columns: auto auto 1fr auto; gap: 14px; align-items: center;
}
.opts-checks { display: flex; gap: 14px; }
.divider-v { width: 1px; align-self: stretch; background: var(--hairline); }
.opts-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.opts-filters .input { height: 26px; font-size: 12px; }
.actions { display: flex; gap: 6px; align-items: center; }

.err-inline {
  margin-top: 10px; padding: 8px 10px;
  border-radius: 6px; background: var(--danger-soft); border: 1px solid var(--danger-line);
  color: oklch(0.9 0.14 22); font-size: 12.5px; display: flex; gap: 8px; align-items: center;
}
.err-inline svg { color: var(--danger); flex-shrink: 0; }

.confirm-banner {
  margin-top: 10px; padding: 12px 14px;
  border-radius: 8px; background: color-mix(in oklab, var(--danger) 8%, var(--bg-2));
  border: 1px solid var(--danger-line); display: flex; gap: 10px; align-items: flex-start;
}
.confirm-banner > svg { color: oklch(0.85 0.18 22); flex-shrink: 0; margin-top: 2px; }
.confirm-body { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.confirm-title { font-size: 12.5px; color: oklch(0.9 0.14 22); line-height: 1.5; }
.confirm-row { display: flex; gap: 6px; align-items: center; }
.confirm-input { flex: 1; max-width: 280px; }

/* Body */
.body { flex: 1; overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.empty-body {
  flex: 1; display: grid; place-items: center; min-height: 300px;
  border: 1px dashed var(--border); border-radius: 12px;
  background: repeating-linear-gradient(45deg, transparent 0 11px, var(--hairline) 11px 12px);
}
.empty-card { background: var(--bg); padding: 24px 28px; border-radius: 12px; border: 1px solid var(--border); text-align: center; max-width: 340px; }
.empty-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 6px; }
.empty-sub { color: var(--muted); font-size: 12.5px; line-height: 1.55; margin-bottom: 16px; }
.empty-hint { display: flex; gap: 6px; justify-content: center; align-items: center; font-size: 11px; color: var(--muted-2); }

/* Log */
.glyph.ok { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 6px var(--ok); display: inline-block; }
.log { padding: 10px 0; background: var(--panel-inset); font-family: var(--font-mono); font-size: 12px; line-height: 1.75; max-height: 240px; overflow: auto; }
.log-row { display: grid; grid-template-columns: 90px 16px 1fr; padding: 0 14px; color: var(--text-dim); }
.log-row.ok { color: oklch(0.88 0.14 155); }
.log-row.err { color: oklch(0.85 0.18 22); }
.log-row.current { color: var(--accent); }
.log-t { color: var(--muted-2); }

/* Plan */
.stats { display: flex; gap: 6px; }
.stat {
  padding: 4px 10px; border-radius: 6px;
  background: var(--bg-2); border: 1px solid var(--hairline);
  display: flex; flex-direction: column; gap: 1px; min-width: 68px;
}
.stat > span:first-child { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.stat > span:last-child { font-size: 13px; font-weight: 600; }

.plan-grid { display: grid; grid-template-columns: 220px 1fr; min-height: 320px; }
.tables { border-right: 1px solid var(--hairline); padding: 10px 0; overflow: auto; max-height: 520px; }
.tables-head { padding: 4px 14px 8px; font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.tbl-row {
  padding: 8px 14px; cursor: pointer;
  border-left: 2px solid transparent;
  display: flex; flex-direction: column; gap: 3px;
}
.tbl-row:hover { background: var(--panel-2); }
.tbl-row.sel { background: color-mix(in oklab, var(--accent) 8%, transparent); border-left-color: var(--accent); }
.tbl-counts { display: flex; gap: 8px; font-size: 11px; color: var(--muted); }

.stmts { display: flex; flex-direction: column; min-height: 0; max-height: 520px; }
.stmts-tabs { display: flex; align-items: center; gap: 4px; padding: 8px 14px; border-bottom: 1px solid var(--hairline); }
.stmts-body { flex: 1; overflow: auto; padding: 12px; background: var(--panel-inset); }
.stmt {
  margin-bottom: 10px; padding: 10px 12px;
  background: var(--bg); border: 1px solid var(--hairline);
  border-left: 3px solid var(--border-2);
  border-radius: 6px;
}
.stmt.destructive {
  background: color-mix(in oklab, var(--danger) 6%, transparent);
  border-color: var(--danger-line);
  border-left-color: var(--danger);
}
.stmt-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.stmt-badge {
  font-size: 10px; font-weight: 600; letter-spacing: .08em;
  color: var(--accent);
}
.stmt-badge.destructive { color: oklch(0.85 0.18 22); }

/* Result */
.result-grid { padding: 16px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.res-card { padding: 12px 14px; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: 8px; }
.res-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
.res-val { font-size: 22px; font-weight: 600; margin-top: 4px; letter-spacing: -0.02em; }
.err-details { margin: 0 16px 16px; background: var(--panel-inset); border: 1px solid var(--danger-line); border-radius: 6px; }
.err-details summary { padding: 10px 12px; cursor: pointer; font-size: 12.5px; font-weight: 600; color: oklch(0.85 0.18 22); }
.err-body { padding: 12px; border-top: 1px solid var(--danger-line); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.7; }
.err-row + .err-row { margin-top: 10px; }

.grow { flex: 1; }
</style>
