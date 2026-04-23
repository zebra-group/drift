<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import type { Profile, SecretValueRef } from "@db-mirror/core";
import { rpc } from "../ipc.js";

type Draft = Omit<Profile, "id"> & { id?: string };
type K8sDraft = Extract<Draft, { kind: "k8s" }> & { userFrom?: SecretValueRef; passwordFrom?: SecretValueRef };

const props = defineProps<{
  initial: Profile | null;
  onSave: (draft: Draft) => Promise<void>;
}>();
const emit = defineEmits<{ cancel: [] }>();

const kind = ref<"direct" | "k8s" | "ssh" | "docker">(props.initial?.kind ?? "direct");
const draft = ref<Draft>(
  props.initial
    ? { ...props.initial }
    : { kind: "direct", name: "", host: "", port: 3306, user: "", password: "", database: "", tls: false } as Draft
);
const error = ref<string | null>(null);
const saving = ref(false);
const showPw = ref(false);
const showSshPw = ref(false);

watch(() => props.initial, (val) => {
  if (val) { draft.value = { ...val }; kind.value = val.kind; }
});

function switchKind(k: "direct" | "k8s" | "ssh" | "docker") {
  kind.value = k;
  const base = { name: draft.value.name, database: (draft.value as any).database ?? "", folder: (draft.value as any).folder };
  if (k === "direct") {
    draft.value = { kind: "direct", ...base, host: "", port: 3306, user: "", password: "", tls: false } as Draft;
  } else if (k === "k8s") {
    draft.value = { kind: "k8s", ...base, context: "", namespace: "", target: { kind: "pod", name: "" }, remotePort: 3306, user: "", password: "" } as Draft;
  } else if (k === "ssh") {
    draft.value = { kind: "ssh", ...base, sshHost: "", sshPort: 22, sshUser: "", sshPassword: "", host: "127.0.0.1", port: 3306, user: "", password: "" } as Draft;
  } else {
    draft.value = { kind: "docker", ...base, containerId: "", containerName: "", internalPort: 3306, user: "root", password: "" } as Draft;
  }
}

const k8s = computed(() => draft.value.kind === "k8s" ? draft.value as K8sDraft : null);
const ssh = computed(() => draft.value.kind === "ssh" ? draft.value as any : null);
const docker = computed(() => draft.value.kind === "docker" ? draft.value as any : null);

// K8s dropdowns
const contexts = ref<string[]>([]);
const namespaces = ref<string[]>([]);
const pods = ref<string[]>([]);
const secrets = ref<string[]>([]);
const keysForUser = ref<string[]>([]);
const keysForPassword = ref<string[]>([]);
const loading = ref({ contexts: false, namespaces: false, pods: false, secrets: false, userKeys: false, pwKeys: false });

// Docker scan
const dockerContainers = ref<{ id: string; name: string; image: string; ports: { internal: number; external: number }[] }[]>([]);
const dockerScanning = ref(false);
const dockerEnvHint = ref<string | null>(null);

onMounted(() => {
  loading.value.contexts = true;
  rpc.k8sContexts().then(c => contexts.value = c).catch(() => {}).finally(() => loading.value.contexts = false);
});

watch(() => k8s.value?.context, (ctx) => {
  namespaces.value = []; pods.value = []; secrets.value = [];
  if (ctx) {
    loading.value.namespaces = true;
    rpc.k8sNamespaces({ context: ctx }).then(n => namespaces.value = n).catch(() => {}).finally(() => loading.value.namespaces = false);
  }
});

watch(() => [k8s.value?.context, k8s.value?.namespace] as const, ([ctx, ns]) => {
  pods.value = []; secrets.value = [];
  if (ctx && ns) {
    loading.value.pods = true; loading.value.secrets = true;
    rpc.k8sPods({ context: ctx, namespace: ns }).then(p => pods.value = p).catch(() => {}).finally(() => loading.value.pods = false);
    rpc.k8sSecrets({ context: ctx, namespace: ns }).then(s => secrets.value = s).catch(() => {}).finally(() => loading.value.secrets = false);
  }
});

watch(() => [k8s.value?.context, k8s.value?.namespace, k8s.value?.userFrom?.secretName] as const, ([ctx, ns, sn]) => {
  keysForUser.value = [];
  if (ctx && ns && sn) {
    loading.value.userKeys = true;
    rpc.k8sSecretKeys({ context: ctx, namespace: ns, secretName: sn }).then(k => keysForUser.value = k).catch(() => {}).finally(() => loading.value.userKeys = false);
  }
});

watch(() => [k8s.value?.context, k8s.value?.namespace, k8s.value?.passwordFrom?.secretName] as const, ([ctx, ns, sn]) => {
  keysForPassword.value = [];
  if (ctx && ns && sn) {
    loading.value.pwKeys = true;
    rpc.k8sSecretKeys({ context: ctx, namespace: ns, secretName: sn }).then(k => keysForPassword.value = k).catch(() => {}).finally(() => loading.value.pwKeys = false);
  }
});

const userFromSecret = computed(() => !!k8s.value?.userFrom);
const passwordFromSecret = computed(() => !!k8s.value?.passwordFrom);
const canUseSecret = computed(() => !!(k8s.value?.context && k8s.value?.namespace));

function setUserFrom(v: SecretValueRef | undefined) { if (draft.value.kind === "k8s") (draft.value as K8sDraft).userFrom = v; }
function setPasswordFrom(v: SecretValueRef | undefined) { if (draft.value.kind === "k8s") (draft.value as K8sDraft).passwordFrom = v; }
function updateUserRef(patch: Partial<SecretValueRef>) {
  const cur = k8s.value?.userFrom ?? { secretName: "", key: "" };
  setUserFrom({ ...cur, ...patch });
}
function updatePasswordRef(patch: Partial<SecretValueRef>) {
  const cur = k8s.value?.passwordFrom ?? { secretName: "", key: "" };
  setPasswordFrom({ ...cur, ...patch });
}

// Docker scan
async function scanDocker() {
  dockerScanning.value = true;
  dockerContainers.value = [];
  try { dockerContainers.value = await rpc.dockerContainers(); }
  catch { dockerContainers.value = []; }
  finally { dockerScanning.value = false; }
}

async function selectDockerContainer(c: typeof dockerContainers.value[0]) {
  if (draft.value.kind !== "docker") return;
  const d = draft.value as any;
  d.containerId = c.id;
  d.containerName = c.name;
  if (!d.name) d.name = c.name;
  const mysqlPort = c.ports.find(p => p.internal === 3306 || p.internal === 3307);
  if (mysqlPort) d.internalPort = mysqlPort.internal;
  dockerEnvHint.value = null;
  try {
    const envs = await rpc.dockerContainerEnvs(c.id);
    const rootPw = envs["MYSQL_ROOT_PASSWORD"] ?? envs["MARIADB_ROOT_PASSWORD"];
    const userPw = envs["MYSQL_PASSWORD"] ?? envs["MARIADB_PASSWORD"];
    const envUser = envs["MYSQL_USER"] ?? envs["MARIADB_USER"];
    if (rootPw) {
      d.user = "root";
      d.password = rootPw;
      dockerEnvHint.value = "Password pre-filled from MYSQL_ROOT_PASSWORD";
    } else if (userPw) {
      d.password = userPw;
      if (envUser) d.user = envUser;
      dockerEnvHint.value = `Password pre-filled from ${envs["MYSQL_PASSWORD"] ? "MYSQL_PASSWORD" : "MARIADB_PASSWORD"}`;
    }
  } catch { /* ignore, user fills manually */ }
}

// Default database dropdown
const availableDbs = ref<string[]>([]);
const dbLoadError = ref<string | null>(null);
const dbLoading = ref(false);

async function loadDbs() {
  dbLoading.value = true; dbLoadError.value = null; availableDbs.value = [];
  try {
    const clean = JSON.parse(JSON.stringify(draft.value)) as Profile;
    availableDbs.value = await rpc.listDatabasesFromProfile(clean);
  } catch (e) {
    dbLoadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    dbLoading.value = false;
  }
}

const sshAuthMode = ref<"password" | "key">(
  props.initial?.kind === "ssh" && props.initial.sshPrivateKeyPath ? "key" : "password"
);
watch(sshAuthMode, (mode) => {
  if (draft.value.kind !== "ssh") return;
  const d = draft.value as any;
  if (mode === "key") { d.sshPassword = undefined; }
  else { d.sshPrivateKeyPath = undefined; }
});

async function submit() {
  error.value = null; saving.value = true;
  try { await props.onSave(JSON.parse(JSON.stringify(draft.value))); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { saving.value = false; }
}
</script>

<template>
  <form class="pform" @submit.prevent="submit" @keydown.esc="emit('cancel')">
    <header class="panel-head">
      <span class="i" :style="{ color: kind === 'k8s' ? 'var(--violet)' : kind === 'ssh' ? 'var(--accent)' : kind === 'docker' ? 'oklch(0.9 0.14 82)' : 'var(--muted)' }">
        <svg v-if="kind === 'k8s'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 1.5L13.5 4v5L8 11.5 2.5 9V4z"/><path d="M8 5v3m-2-1h4"/></svg>
        <svg v-else-if="kind === 'ssh'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="8" rx="1.5"/><path d="M5 5V4a3 3 0 0 1 6 0v1"/><path d="M8 9v2m-1-1h2"/></svg>
        <svg v-else-if="kind === 'docker'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="5" width="14" height="7" rx="1.5"/><path d="M4 5V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"/><path d="M4 8h1M7 8h1M10 8h1"/></svg>
        <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3"/><rect x="4.5" y="5" width="7" height="4" rx="1"/><path d="M8 9v3a2 2 0 0 1-2 2"/></svg>
      </span>
      <span>{{ initial ? "Edit profile" : "New profile" }}</span>
      <span v-if="(draft as any).name" class="mono muted" style="font-weight:400; font-size:11.5px">· {{ (draft as any).name }}</span>
    </header>

    <div class="body">
      <!-- Kind selector -->
      <div>
        <div class="field-label">Connection kind</div>
        <div class="kind-grid">
          <button type="button" class="kind-card" :class="{ on: kind === 'direct' }" @click="switchKind('direct')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3"/><rect x="4.5" y="5" width="7" height="4" rx="1"/><path d="M8 9v3a2 2 0 0 1-2 2"/></svg>
            <div><div class="kc-title">Direct TCP</div><div class="kc-sub">Host, port, credentials.</div></div>
          </button>
          <button type="button" class="kind-card" :class="{ on: kind === 'ssh' }" @click="switchKind('ssh')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="8" rx="1.5"/><path d="M5 5V4a3 3 0 0 1 6 0v1"/><path d="M8 9v2m-1-1h2"/></svg>
            <div><div class="kc-title">TCP over SSH</div><div class="kc-sub">Tunnel through a jump host.</div></div>
          </button>
          <button type="button" class="kind-card" :class="{ on: kind === 'k8s' }" @click="switchKind('k8s')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 1.5L13.5 4v5L8 11.5 2.5 9V4z"/><path d="M8 5v3m-2-1h4"/></svg>
            <div><div class="kc-title">Kubernetes</div><div class="kc-sub">Port-forward via kubectl.</div></div>
          </button>
          <button type="button" class="kind-card" :class="{ on: kind === 'docker' }" @click="switchKind('docker')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="5" width="14" height="7" rx="1.5"/><path d="M4 5V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"/><path d="M4 8h1M7 8h1M10 8h1"/></svg>
            <div><div class="kc-title">Docker</div><div class="kc-sub">Local container auto-discovery.</div></div>
          </button>
        </div>
      </div>

      <!-- Common: name + folder -->
      <div class="grid-2">
        <div>
          <div class="field-label">Profile name</div>
          <input class="input" v-model="(draft as any).name" required placeholder="e.g. production · read-replica" />
        </div>
        <div>
          <div class="field-label">Folder <span class="muted" style="font-weight:400; text-transform:none; letter-spacing:0">(optional)</span></div>
          <input class="input" v-model="(draft as any).folder" placeholder="e.g. Production" />
        </div>
      </div>

      <!-- ── Direct ── -->
      <template v-if="draft.kind === 'direct'">
        <div class="grid-2-port">
          <div>
            <div class="field-label">Host</div>
            <input class="input mono" v-model="draft.host" required placeholder="db.internal" />
          </div>
          <div>
            <div class="field-label">Port</div>
            <input class="input mono num" type="number" v-model.number="draft.port" required />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="field-label">Username</div>
            <input class="input mono" v-model="draft.user" required />
          </div>
          <div>
            <div class="field-label">Password</div>
            <div class="pw-wrap">
              <input class="input mono" :type="showPw ? 'text' : 'password'" v-model="draft.password" />
              <button type="button" class="btn ghost sm pw-eye" @click="showPw = !showPw" tabindex="-1">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z"/><circle cx="8" cy="8" r="2"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div>
          <div class="field-label">Require TLS</div>
          <label class="row tls-row">
            <label class="switch"><input type="checkbox" v-model="(draft as any).tls" /><span class="track"><span class="thumb" /></span></label>
            <span class="muted">Enforce TLS, reject unverified certs</span>
          </label>
        </div>
      </template>

      <!-- ── SSH ── -->
      <template v-if="draft.kind === 'ssh' && ssh">
        <div class="section-sep"><span>SSH Jump Host</span><div class="line" /></div>
        <div class="grid-2-port">
          <div>
            <div class="field-label">SSH Host</div>
            <input class="input mono" v-model="ssh.sshHost" required placeholder="bastion.example.com" />
          </div>
          <div>
            <div class="field-label">SSH Port</div>
            <input class="input mono num" type="number" v-model.number="ssh.sshPort" required />
          </div>
        </div>
        <div>
          <div class="field-label">SSH Username</div>
          <input class="input mono" v-model="ssh.sshUser" required placeholder="ubuntu" />
        </div>
        <div>
          <div class="field-label">Authentication</div>
          <div class="seg" style="width:100%">
            <button type="button" :class="{ on: sshAuthMode === 'password' }" @click="sshAuthMode = 'password'" style="flex:1; justify-content:center">Password</button>
            <button type="button" :class="{ on: sshAuthMode === 'key' }" @click="sshAuthMode = 'key'" style="flex:1; justify-content:center">Private Key</button>
          </div>
        </div>
        <div v-if="sshAuthMode === 'password'">
          <div class="field-label">SSH Password</div>
          <div class="pw-wrap">
            <input class="input mono" :type="showSshPw ? 'text' : 'password'" v-model="ssh.sshPassword" />
            <button type="button" class="btn ghost sm pw-eye" @click="showSshPw = !showSshPw" tabindex="-1">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z"/><circle cx="8" cy="8" r="2"/></svg>
            </button>
          </div>
        </div>
        <div v-else>
          <div class="field-label">Private key path</div>
          <input class="input mono" v-model="ssh.sshPrivateKeyPath" placeholder="~/.ssh/id_rsa" />
        </div>

        <div class="section-sep"><span>Target Database</span><div class="line" /></div>
        <div class="grid-2-port">
          <div>
            <div class="field-label">Remote Host</div>
            <input class="input mono" v-model="ssh.host" required placeholder="127.0.0.1" />
          </div>
          <div>
            <div class="field-label">Port</div>
            <input class="input mono num" type="number" v-model.number="ssh.port" required />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="field-label">DB Username</div>
            <input class="input mono" v-model="ssh.user" required />
          </div>
          <div>
            <div class="field-label">DB Password</div>
            <div class="pw-wrap">
              <input class="input mono" :type="showPw ? 'text' : 'password'" v-model="ssh.password" />
              <button type="button" class="btn ghost sm pw-eye" @click="showPw = !showPw" tabindex="-1">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z"/><circle cx="8" cy="8" r="2"/></svg>
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- ── Docker ── -->
      <template v-if="draft.kind === 'docker' && docker">
        <div class="docker-scan-row">
          <button type="button" class="btn" @click="scanDocker" :disabled="dockerScanning">
            <span v-if="dockerScanning" class="spinner sm" />
            <svg v-else viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 1 0 12 0 6 6 0 0 0-12 0M8 2v2M8 12v2M2 8H4M12 8h2"/></svg>
            Scan running Docker containers
          </button>
          <span v-if="dockerContainers.length === 0 && !dockerScanning" class="muted" style="font-size:12px">No MySQL/MariaDB containers found yet.</span>
        </div>

        <div v-if="dockerContainers.length" class="docker-list">
          <div
            v-for="c in dockerContainers" :key="c.id"
            class="docker-item"
            :class="{ sel: docker.containerId === c.id }"
            @click="selectDockerContainer(c)"
          >
            <div class="row" style="gap:8px">
              <span class="mono" style="font-weight:600; font-size:12.5px">{{ c.name }}</span>
              <span class="pill" style="font-size:10px; height:16px; padding:0 5px">{{ c.id }}</span>
            </div>
            <div style="font-size:11.5px; color:var(--muted); margin-top:2px">{{ c.image }}</div>
            <div class="mono" style="font-size:11px; color:var(--text-dim); margin-top:3px">
              <span v-for="p in c.ports" :key="p.internal">:{{ p.external }}→{{ p.internal }}</span>
            </div>
          </div>
        </div>

        <div class="grid-2">
          <div>
            <div class="field-label">Container ID</div>
            <input class="input mono" v-model="docker.containerId" required placeholder="abc123def456" />
          </div>
          <div>
            <div class="field-label">MySQL Port (internal)</div>
            <input class="input mono num" type="number" v-model.number="docker.internalPort" required />
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="field-label">DB Username</div>
            <input class="input mono" v-model="docker.user" required />
          </div>
          <div>
            <div class="field-label">DB Password</div>
            <div class="pw-wrap">
              <input class="input mono" :type="showPw ? 'text' : 'password'" v-model="docker.password" />
              <button type="button" class="btn ghost sm pw-eye" @click="showPw = !showPw" tabindex="-1">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z"/><circle cx="8" cy="8" r="2"/></svg>
              </button>
            </div>
            <div v-if="dockerEnvHint" class="docker-env-hint">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M8 10v.01"/><circle cx="8" cy="8" r="6"/></svg>
              {{ dockerEnvHint }}
            </div>
          </div>
        </div>
      </template>

      <!-- ── K8s ── -->
      <template v-if="draft.kind === 'k8s' && k8s">
        <div class="grid-2">
          <div>
            <div class="field-label">Kube-context <span v-if="loading.contexts" class="spinner sm" /></div>
            <select class="select mono" v-model="k8s.context">
              <option value="">— choose —</option>
              <option v-for="c in contexts" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div>
            <div class="field-label">Namespace <span v-if="loading.namespaces" class="spinner sm" /></div>
            <select class="select mono" v-model="k8s.namespace" :disabled="!k8s.context">
              <option value="">— choose —</option>
              <option v-for="n in namespaces" :key="n" :value="n">{{ n }}</option>
            </select>
          </div>
        </div>
        <div class="grid-3">
          <div>
            <div class="field-label">Target</div>
            <select class="select" v-model="k8s.target.kind">
              <option value="pod">Pod</option>
              <option value="service">Service</option>
            </select>
          </div>
          <div>
            <div class="field-label">Name <span v-if="loading.pods && k8s.target.kind === 'pod'" class="spinner sm" /></div>
            <select v-if="k8s.target.kind === 'pod'" class="select mono" v-model="k8s.target.name" :disabled="!k8s.namespace">
              <option value="">— choose —</option>
              <option v-for="p in pods" :key="p" :value="p">{{ p }}</option>
            </select>
            <input v-else class="input mono" v-model="k8s.target.name" placeholder="service-name" />
          </div>
          <div>
            <div class="field-label">Port</div>
            <input class="input mono num" type="number" v-model.number="k8s.remotePort" />
          </div>
        </div>

        <div class="section-sep"><span>Credentials</span><div class="line" /></div>

        <!-- Username -->
        <div class="cred-card">
          <div class="cred-head">
            <span class="cred-label">Username</span>
            <div class="grow" />
            <div class="seg">
              <button type="button" :class="{ on: !userFromSecret }" @click="setUserFrom(undefined)">Manual</button>
              <button type="button" :class="{ on: userFromSecret }" :disabled="!canUseSecret" @click="setUserFrom({ secretName: '', key: '' })">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="8" r="2.5"/><path d="M7.5 8h7M12 6v4M14 6v4"/></svg>
                From K8s secret
              </button>
            </div>
          </div>
          <template v-if="!userFromSecret">
            <input class="input mono" v-model="k8s.user" required />
          </template>
          <div v-else-if="k8s.userFrom" class="grid-2">
            <div>
              <div class="field-label">Secret <span v-if="loading.secrets" class="spinner sm" /></div>
              <select class="select mono" :value="k8s.userFrom.secretName" @change="(e: Event) => updateUserRef({ secretName: (e.target as HTMLSelectElement).value, key: '' })" required>
                <option value="">— choose —</option>
                <option v-for="s in secrets" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div>
              <div class="field-label">Key <span v-if="loading.userKeys" class="spinner sm" /></div>
              <select class="select mono" :value="k8s.userFrom.key" @change="(e: Event) => updateUserRef({ key: (e.target as HTMLSelectElement).value })" :disabled="!k8s.userFrom.secretName" required>
                <option value="">— choose —</option>
                <option v-for="k in keysForUser" :key="k" :value="k">{{ k }}</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Password -->
        <div class="cred-card">
          <div class="cred-head">
            <span class="cred-label">Password</span>
            <div class="grow" />
            <div class="seg">
              <button type="button" :class="{ on: !passwordFromSecret }" @click="setPasswordFrom(undefined)">Manual</button>
              <button type="button" :class="{ on: passwordFromSecret }" :disabled="!canUseSecret" @click="setPasswordFrom({ secretName: '', key: '' })">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="8" r="2.5"/><path d="M7.5 8h7M12 6v4M14 6v4"/></svg>
                From K8s secret
              </button>
            </div>
          </div>
          <template v-if="!passwordFromSecret">
            <input class="input mono" type="password" v-model="k8s.password" required />
          </template>
          <div v-else-if="k8s.passwordFrom" class="grid-2">
            <div>
              <div class="field-label">Secret <span v-if="loading.secrets" class="spinner sm" /></div>
              <select class="select mono" :value="k8s.passwordFrom.secretName" @change="(e: Event) => updatePasswordRef({ secretName: (e.target as HTMLSelectElement).value, key: '' })" required>
                <option value="">— choose —</option>
                <option v-for="s in secrets" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div>
              <div class="field-label">Key <span v-if="loading.pwKeys" class="spinner sm" /></div>
              <select class="select mono" :value="k8s.passwordFrom.key" @change="(e: Event) => updatePasswordRef({ key: (e.target as HTMLSelectElement).value })" :disabled="!k8s.passwordFrom.secretName" required>
                <option value="">— choose —</option>
                <option v-for="k in keysForPassword" :key="k" :value="k">{{ k }}</option>
              </select>
            </div>
          </div>
        </div>
      </template>

      <!-- Default database (all kinds) -->
      <div>
        <div class="field-label">
          Default database
          <button type="button" class="btn ghost sm" style="height:18px; padding:0 6px; font-size:10.5px; margin-left:4px" @click="loadDbs" :disabled="dbLoading">
            <span v-if="dbLoading" class="spinner sm" />
            <svg v-else viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 1 0 1.5-4M2 2v4h4"/></svg>
            {{ availableDbs.length ? 'Reload' : 'Load databases' }}
          </button>
        </div>
        <select v-if="availableDbs.length" class="select mono" v-model="(draft as any).database">
          <option value="">— none —</option>
          <option v-for="db in availableDbs" :key="db" :value="db">{{ db }}</option>
        </select>
        <input v-else class="input mono" v-model="(draft as any).database" placeholder="schema name (optional)" />
        <div v-if="dbLoadError" class="db-err">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 7v3M8 5v.01"/></svg>
          {{ dbLoadError }}
        </div>
      </div>

      <div v-if="error" class="err">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5v.01"/></svg>
        <span>{{ error }}</span>
      </div>
    </div>

    <footer class="foot">
      <button type="button" class="btn ghost" @click="emit('cancel')">Cancel</button>
      <div class="grow" />
      <span class="muted hint"><span class="kbd">⌘</span> <span class="kbd">S</span> to save</span>
      <button class="btn primary" type="submit" :disabled="saving">
        <span v-if="saving" class="spinner dark" />
        <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3 3 7-7"/></svg>
        Save profile
      </button>
    </footer>
  </form>
</template>

<style scoped>
.pform { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.body { flex: 1; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }

.kind-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.kind-card {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 12px; border-radius: 8px; text-align: left;
  background: var(--panel-inset); border: 1px solid var(--border);
  cursor: pointer; color: var(--text);
  transition: all .12s var(--ease);
}
.kind-card:hover { border-color: var(--border-2); }
.kind-card.on { background: color-mix(in oklab, var(--accent) 9%, var(--panel-inset)); border-color: var(--accent-line); }
.kind-card svg { color: var(--muted); margin-top: 1px; flex-shrink: 0; }
.kind-card.on svg { color: var(--accent); }
.kc-title { font-weight: 600; font-size: 12.5px; }
.kc-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; line-height: 1.4; }

.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.grid-2-port { display: grid; grid-template-columns: 1fr 96px; gap: 10px; }
.grid-3 { display: grid; grid-template-columns: 120px 1fr 96px; gap: 10px; }

.pw-wrap { position: relative; }
.pw-eye { position: absolute; right: 3px; top: 3px; height: 24px; width: 24px; padding: 0; justify-content: center; }

.tls-row { gap: 10px; }
.muted { color: var(--muted); font-size: 12px; }

.section-sep { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.section-sep span { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.section-sep .line { flex: 1; height: 1px; background: var(--hairline); }

.cred-card { padding: 10px; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: 8px; }
.cred-head { display: flex; align-items: center; margin-bottom: 10px; }
.cred-label { font-size: 12px; font-weight: 600; }
.grow { flex: 1; }

/* Docker */
.docker-scan-row { display: flex; gap: 10px; align-items: center; }
.docker-list { display: flex; flex-direction: column; gap: 6px; }
.docker-item {
  padding: 10px 12px; border-radius: 8px;
  background: var(--panel-inset); border: 1px solid var(--border);
  cursor: pointer; transition: border-color .12s var(--ease);
}
.docker-item:hover { border-color: var(--border-2); }
.docker-item.sel { background: color-mix(in oklab, var(--accent) 9%, var(--panel-inset)); border-color: var(--accent-line); }

.docker-env-hint { font-size: 11px; color: oklch(0.75 0.12 140); display: flex; gap: 5px; align-items: center; margin-top: 5px; }
.db-err { font-size: 11px; color: oklch(0.85 0.18 22); display: flex; gap: 5px; align-items: center; margin-top: 6px; }

.err {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 10px; border-radius: 6px;
  background: var(--danger-soft); border: 1px solid var(--danger-line);
  color: oklch(0.9 0.14 22); font-size: 12.5px;
}
.err svg { color: var(--danger); flex-shrink: 0; margin-top: 1px; }

.foot {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-top: 1px solid var(--hairline);
}
.hint { font-size: 11.5px; margin-right: 6px; }
</style>
