<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { rpc } from "../ipc.js";
import type { Profile } from "@db-mirror/core";
import ProfileForm from "./ProfileForm.vue";

const profiles = ref<readonly Profile[]>([]);
const editing = ref<Profile | "new" | null>(null);
const filter = ref("");
const busy = ref(false);

// Dump modal state
const dumpModal = ref<{ profileId: string; databases: string[]; database: string; loading: boolean; loadError: string | null; running: boolean; log: string[]; result: string | null } | null>(null);

async function refresh() {
  busy.value = true;
  try { profiles.value = await rpc.listProfiles(); }
  finally { busy.value = false; }
}
onMounted(refresh);

async function onSaved() {
  editing.value = null;
  await refresh();
}

async function remove(p: Profile) {
  if (confirm(`Delete "${p.name}"? This cannot be undone.`)) {
    await rpc.removeProfile(p.id);
    await refresh();
    if (editing.value && editing.value !== "new" && (editing.value as Profile).id === p.id) editing.value = null;
  }
}

async function duplicate(p: Profile) {
  await rpc.duplicateProfile(p.id);
  await refresh();
}

async function saveProfile(draft: Omit<Profile, "id"> & { id?: string }) {
  await rpc.upsertProfile(draft as Profile);
  await onSaved();
}

function profileTarget(p: Profile): string {
  if (p.kind === "direct") return `${p.host}:${p.port}`;
  if (p.kind === "ssh") return `ssh://${p.sshUser}@${p.sshHost} → ${p.host}:${p.port}`;
  if (p.kind === "docker") return `docker:${p.containerName}:${p.internalPort}`;
  return `${p.context.split(":").slice(-1)[0]} / ${p.namespace} / ${p.target.kind}:${p.target.name}:${p.remotePort}`;
}

function kindLabel(p: Profile): string {
  if (p.kind === "ssh") return "ssh";
  if (p.kind === "docker") return "docker";
  if (p.kind === "k8s") return "k8s";
  return "direct";
}

const filtered = computed(() => {
  const q = filter.value.toLowerCase();
  const list = q
    ? profiles.value.filter(p =>
        p.name.toLowerCase().includes(q) ||
        profileTarget(p).toLowerCase().includes(q)
      )
    : [...profiles.value];
  return list;
});

// Group by folder
const folderGroups = computed(() => {
  const map = new Map<string, Profile[]>();
  for (const p of filtered.value) {
    const key = p.folder ?? "";
    const arr = map.get(key) ?? [];
    arr.push(p);
    map.set(key, arr);
  }
  // Sort: named folders first (alphabetically), then ungrouped
  const entries = [...map.entries()].sort(([a], [b]) => {
    if (a === "" && b !== "") return 1;
    if (a !== "" && b === "") return -1;
    return a.localeCompare(b);
  });
  return entries;
});

const collapsedFolders = ref<Set<string>>(new Set());
function toggleFolder(name: string) {
  const s = new Set(collapsedFolders.value);
  if (s.has(name)) s.delete(name); else s.add(name);
  collapsedFolders.value = s;
}

// Dump helpers
async function openDump(p: Profile) {
  dumpModal.value = { profileId: p.id, databases: [], database: p.database ?? "", loading: true, loadError: null, running: false, log: [], result: null };
  try {
    const dbs = await rpc.listDatabases(p.id);
    dumpModal.value.databases = dbs;
    if (!dumpModal.value.database && dbs.length) dumpModal.value.database = dbs[0];
  } catch (e) {
    if (dumpModal.value) dumpModal.value.loadError = e instanceof Error ? e.message : String(e);
  } finally { if (dumpModal.value) dumpModal.value.loading = false; }
}

async function runDump() {
  if (!dumpModal.value?.database) return;
  dumpModal.value.running = true;
  dumpModal.value.log = [];
  dumpModal.value.result = null;
  const unsub = rpc.onDumpProgress((msg) => { dumpModal.value?.log.push(msg); });
  try {
    const path = await rpc.dumpToFile({ profileId: dumpModal.value.profileId, database: dumpModal.value.database });
    if (dumpModal.value) dumpModal.value.result = path;
  } finally {
    unsub();
    if (dumpModal.value) dumpModal.value.running = false;
  }
}
</script>

<template>
  <div class="connections">
    <section class="panel list">
      <header class="panel-head">
        <span>Connection profiles</span>
        <span class="pill">{{ profiles.length }}</span>
        <div class="grow" />
        <div class="search">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M13 13l-3-3"/></svg>
          <input class="input sm" placeholder="Filter by name or host…" v-model="filter" />
        </div>
        <button class="btn sm primary" @click="editing = 'new'">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
          New profile
        </button>
      </header>

      <div class="body">
        <template v-if="folderGroups.length">
          <template v-for="[folder, group] in folderGroups" :key="folder">
            <!-- Folder header (only when there are named folders or multiple groups) -->
            <div v-if="folder || folderGroups.length > 1" class="folder-row" @click="toggleFolder(folder)">
              <svg class="fold-chevron" :class="{ open: !collapsedFolders.has(folder) }" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a1 1 0 0 1 1-1h4l1.5 2H13a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>
              <span>{{ folder || "Ungrouped" }}</span>
              <span class="pill" style="margin-left:auto">{{ group.length }}</span>
            </div>

            <table class="tbl" v-if="!collapsedFolders.has(folder)">
              <thead v-if="folder === folderGroups[0][0]">
                <tr>
                  <th style="width:28px"></th>
                  <th>Name</th>
                  <th>Target</th>
                  <th>Default DB</th>
                  <th style="width:64px"></th>
                  <th style="width:96px; text-align:right"></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in group" :key="p.id"
                  class="row-hover"
                  :class="{ selected: editing && editing !== 'new' && (editing as Profile).id === p.id }"
                  @click="editing = p"
                >
                  <td>
                    <span class="k" :class="p.kind">
                      <svg v-if="p.kind === 'k8s'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 1.5L13.5 4v5L8 11.5 2.5 9V4z"/><path d="M8 5v3m-2-1h4"/></svg>
                      <svg v-else-if="p.kind === 'ssh'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="8" rx="1.5"/><path d="M5 5V4a3 3 0 0 1 6 0v1"/><path d="M8 9v2m-1-1h2"/></svg>
                      <svg v-else-if="p.kind === 'docker'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="5" width="14" height="7" rx="1.5"/><path d="M4 5V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"/><path d="M4 8h1M7 8h1M10 8h1"/></svg>
                      <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3"/><rect x="4.5" y="5" width="7" height="4" rx="1"/><path d="M8 9v3a2 2 0 0 1-2 2"/></svg>
                    </span>
                  </td>
                  <td><div class="pname">{{ p.name }}</div></td>
                  <td class="mono tgt">{{ profileTarget(p) }}</td>
                  <td class="mono" style="font-size:12px">{{ p.database ?? "—" }}</td>
                  <td>
                    <span class="pill" :class="{ violet: p.kind === 'k8s', accent: p.kind === 'ssh', warn: p.kind === 'docker' }">{{ kindLabel(p) }}</span>
                  </td>
                  <td class="actions">
                    <button class="btn ghost sm icon" title="Dump to file" @click.stop="openDump(p)">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>
                    </button>
                    <button class="btn ghost sm icon" title="Duplicate" @click.stop="duplicate(p)">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>
                    </button>
                    <button class="btn ghost sm icon" title="Edit" @click.stop="editing = p">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M11 3l2 2-7 7H4v-2z"/></svg>
                    </button>
                    <button class="btn ghost sm icon" title="Delete" @click.stop="remove(p)">
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="oklch(0.8 0.18 22)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4l1 9a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-9"/></svg>
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </template>

        <div v-else class="empty">
          <div class="empty-icon">
            <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3"/><rect x="4.5" y="5" width="7" height="4" rx="1"/><path d="M8 9v3a2 2 0 0 1-2 2"/></svg>
          </div>
          <div class="empty-title">{{ profiles.length ? "No matches" : "No profiles yet" }}</div>
          <div class="empty-sub">{{ profiles.length ? "Clear the filter or create a new profile." : "Store a MySQL or MariaDB connection to start mirroring." }}</div>
          <button class="btn primary" @click="editing = 'new'">Create first profile</button>
        </div>
      </div>

      <footer class="hints">
        <span class="kbd">↑</span><span class="kbd">↓</span><span>navigate</span>
        <span class="sep" />
        <span class="kbd">↵</span><span>edit</span>
        <span class="sep" />
        <span class="kbd">⌘</span><span class="kbd">N</span><span>new</span>
        <span class="sep" />
        <span class="kbd">⌫</span><span>delete</span>
      </footer>
    </section>

    <section class="panel form">
      <ProfileForm
        v-if="editing"
        :initial="editing === 'new' ? null : editing as Profile"
        :on-save="saveProfile"
        @cancel="editing = null"
      />
      <div v-else class="placeholder">
        <div class="ph-icon">
          <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3"/><rect x="4.5" y="5" width="7" height="4" rx="1"/><path d="M8 9v3a2 2 0 0 1-2 2"/></svg>
        </div>
        <div class="ph-title">Select a profile to edit</div>
        <div class="ph-sub">Choose a connection from the list, or create a new one. Profiles stay encrypted at rest.</div>
        <button class="btn primary" @click="editing = 'new'">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3v10M3 8h10"/></svg>
          Create new profile
        </button>
      </div>
    </section>
  </div>

  <!-- Dump modal -->
  <teleport to="body">
    <div v-if="dumpModal" class="modal-backdrop" @click.self="!dumpModal.running && (dumpModal = null)">
      <div class="modal">
        <div class="modal-head">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>
          Dump to file
          <div class="grow" />
          <button class="btn ghost sm icon" @click="dumpModal = null" :disabled="dumpModal.running">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="field-label">Database <span v-if="dumpModal.loading" class="spinner sm" /></div>
          <select v-if="dumpModal.databases.length" class="select mono" v-model="dumpModal.database" :disabled="dumpModal.running">
            <option v-for="db in dumpModal.databases" :key="db" :value="db">{{ db }}</option>
          </select>
          <input v-else class="input mono" v-model="dumpModal.database" placeholder="database name" :disabled="dumpModal.running" />
          <div v-if="dumpModal.loadError" class="dump-load-err">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 7v3M8 5v.01"/></svg>
            Could not load database list: {{ dumpModal.loadError }}
          </div>

          <div v-if="dumpModal.log.length" class="dump-log">
            <div v-for="(l, i) in dumpModal.log" :key="i" class="dump-log-row" :class="{ ok: l.startsWith('✓'), warn: l.startsWith('⚠') }">{{ l }}</div>
          </div>

          <div v-if="dumpModal.result" class="dump-result">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--ok)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg>
            <span class="mono" style="font-size:11.5px; word-break:break-all">{{ dumpModal.result }}</span>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="dumpModal = null" :disabled="dumpModal.running">Cancel</button>
          <div class="grow" />
          <button class="btn primary" @click="runDump" :disabled="dumpModal.running || !dumpModal.database || dumpModal.loading">
            <span v-if="dumpModal.running" class="spinner dark" />
            <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7M5 7l3 3 3-3"/><path d="M3 12h10"/></svg>
            {{ dumpModal.running ? "Dumping…" : "Choose folder & dump" }}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.connections {
  display: grid; grid-template-columns: 1.1fr 1fr; gap: 14px;
  padding: 14px; height: 100%; overflow: hidden;
}
.panel.list, .panel.form { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.grow { flex: 1; }
.search { position: relative; width: 220px; }
.search svg { position: absolute; left: 9px; top: 6px; color: var(--muted); }
.search .input { padding-left: 26px; height: 26px; font-size: 12px; }

.body { flex: 1; overflow: auto; }

/* Folder row */
.folder-row {
  display: flex; align-items: center; gap: 7px;
  padding: 6px 12px; cursor: pointer;
  font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
  color: var(--muted); background: var(--bg-2);
  border-bottom: 1px solid var(--hairline);
  user-select: none;
}
.folder-row:hover { color: var(--text-dim); }
.fold-chevron { transition: transform .15s; flex-shrink: 0; }
.fold-chevron.open { transform: rotate(90deg); }

.k.k8s { color: var(--violet); }
.k.direct { color: var(--muted); }
.k.ssh { color: var(--accent); }
.k.docker { color: oklch(0.9 0.14 82); }
.pname { font-weight: 500; }
.tgt { font-size: 12px; color: var(--text-dim); }
.actions { text-align: right; white-space: nowrap; }
.actions .btn { padding: 0; width: 24px; justify-content: center; margin-left: 2px; }

.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px; text-align: center; }
.empty-icon {
  width: 52px; height: 52px; border-radius: 14px;
  background: var(--panel-inset); border: 1px dashed var(--border-2);
  color: var(--muted); display: grid; place-items: center;
}
.empty-title { font-size: 14px; font-weight: 600; }
.empty-sub { color: var(--muted); font-size: 12px; max-width: 280px; line-height: 1.5; margin-bottom: 8px; }

.hints {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 14px; border-top: 1px solid var(--hairline);
  font-size: 11.5px; color: var(--muted);
}
.hints .sep { width: 1px; height: 12px; background: var(--border); margin: 0 4px; }

.placeholder { display: grid; place-items: center; padding: 40px; height: 100%; }
.placeholder > * + * { margin-top: 12px; }
.ph-icon {
  width: 56px; height: 56px; border-radius: 14px;
  background: var(--panel-inset); border: 1px dashed var(--border-2);
  color: var(--muted); display: grid; place-items: center;
}
.ph-title { font-size: 14px; font-weight: 600; }
.ph-sub { color: var(--muted); font-size: 12px; max-width: 280px; text-align: center; line-height: 1.5; }

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,.6); backdrop-filter: blur(4px);
  display: grid; place-items: center;
}
.modal {
  width: 440px; background: var(--panel); border: 1px solid var(--border);
  border-radius: 12px; box-shadow: var(--shadow-2);
  display: flex; flex-direction: column;
}
.modal-head {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  border-bottom: 1px solid var(--hairline); font-weight: 600; font-size: 13px;
}
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-foot { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--hairline); align-items: center; }

.dump-log {
  background: var(--panel-inset); border: 1px solid var(--hairline); border-radius: 6px;
  padding: 10px 12px; font-family: var(--font-mono); font-size: 11.5px;
  line-height: 1.7; max-height: 160px; overflow: auto; color: var(--text-dim);
}
.dump-log-row.ok { color: oklch(0.88 0.14 155); }
.dump-log-row.warn { color: oklch(0.9 0.14 82); }

.dump-load-err { font-size: 11px; color: oklch(0.85 0.18 22); display: flex; gap: 5px; align-items: flex-start; margin-top: 6px; line-height: 1.5; }

.dump-result {
  display: flex; gap: 8px; align-items: flex-start; padding: 10px;
  background: var(--ok-soft); border: 1px solid color-mix(in oklab, var(--ok) 35%, transparent);
  border-radius: 6px;
}
</style>
