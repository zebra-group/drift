<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { rpc } from "../ipc.js";

const emit = defineEmits<{ unlocked: [] }>();

const exists = ref<boolean | null>(null);
const passphrase = ref("");
const confirm = ref("");
const showPw = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => { exists.value = await rpc.vaultExists(); });

const strength = computed(() => {
  const p = passphrase.value;
  let s = 0;
  if (p.length >= 8)  s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) && /[^\w]/.test(p)) s++;
  return s;
});

const strengthLabel = computed(() =>
  ["weak", "fair", "good", "strong"][Math.max(0, strength.value - 1)] ?? "—"
);

async function submit() {
  busy.value = true; error.value = null;
  try {
    if (exists.value) {
      await rpc.vaultOpen({ passphrase: passphrase.value });
    } else {
      if (passphrase.value !== confirm.value) throw new Error("Passphrases don't match");
      if (passphrase.value.length < 8) throw new Error("At least 8 characters required");
      await rpc.vaultCreate({ passphrase: passphrase.value });
    }
    emit("unlocked");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="unlock">
    <div class="grid-bg" />
    <div class="glow" />

    <div v-if="exists === null" class="loading">
      <span class="spinner" /> Loading vault…
    </div>

    <div v-else class="wrap">
      <div class="head">
        <div class="logo"><span class="brandmark" /></div>
        <div class="eyebrow">DB-MIRROR · SECURE VAULT</div>
      </div>

      <form class="panel card" @submit.prevent="submit">
        <div class="title">{{ exists ? "Unlock your vault" : "Create your vault" }}</div>
        <div class="sub">
          {{ exists
            ? "Enter the master passphrase to decrypt stored connection profiles."
            : "Your credentials are encrypted at rest with this passphrase. We can't recover it if you lose it." }}
        </div>

        <div class="fields">
          <div>
            <div class="field-label">Master passphrase</div>
            <div class="pw-wrap">
              <svg class="pw-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>
              <input
                class="input mono pw-input"
                :type="showPw ? 'text' : 'password'"
                autofocus
                v-model="passphrase"
                autocomplete="current-password"
              />
              <button type="button" class="btn ghost sm pw-eye" @click="showPw = !showPw" tabindex="-1">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z"/><circle cx="8" cy="8" r="2"/></svg>
              </button>
            </div>
          </div>

          <div v-if="!exists">
            <div class="field-label">Confirm passphrase</div>
            <input class="input mono" type="password" v-model="confirm" />
            <div class="meter">
              <div v-for="i in 4" :key="i" :class="['bar', i <= strength ? `s${strength}` : '']" />
            </div>
            <div class="meter-label">
              Strength: <span :class="`lbl-s${strength}`">{{ strengthLabel }}</span>
              <span class="muted" v-if="passphrase"> · {{ passphrase.length }} characters</span>
            </div>
          </div>

          <div v-if="error" class="error">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5v.01"/></svg>
            <div>
              <div class="err-title">{{ exists ? "Wrong passphrase" : "Cannot create vault" }}</div>
              <div class="err-body">{{ error }}</div>
            </div>
          </div>

          <button class="btn primary lg submit" type="submit" :disabled="busy || !passphrase">
            <span v-if="busy" class="spinner dark" />
            <template v-else>
              {{ exists ? "Unlock" : "Create vault" }}
              <span v-if="exists" class="kbd enter">↵</span>
            </template>
          </button>
        </div>
      </form>

      <div class="foot">
        <span>AES-256-GCM · Argon2id</span>
        <span class="muted">Vault: ~/Library/Application Support/db-mirror/vault</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unlock {
  position: relative; height: 100%;
  background: var(--bg); overflow: hidden;
  display: grid; place-items: center;
}
.grid-bg {
  position: absolute; inset: 0; opacity: .35;
  background-image:
    linear-gradient(var(--hairline) 1px, transparent 1px),
    linear-gradient(90deg, var(--hairline) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(circle at 50% 40%, black, transparent 70%);
}
.glow {
  position: absolute; inset: 0;
  background: radial-gradient(500px circle at 50% 35%, color-mix(in oklab, var(--accent) 14%, transparent), transparent 60%);
}
.loading { position: relative; color: var(--muted); display: flex; gap: 10px; align-items: center; }
.wrap { position: relative; width: 400px; display: flex; flex-direction: column; gap: 18px; }
.head { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.logo {
  width: 44px; height: 44px; border-radius: 12px;
  background: linear-gradient(180deg, #131c28, #0d131b);
  border: 1px solid var(--border);
  box-shadow: 0 10px 30px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03);
  display: grid; place-items: center;
}
.logo .brandmark { width: 22px; height: 22px; border-radius: 6px; }
.eyebrow { font-size: 11px; letter-spacing: .14em; color: var(--muted); font-weight: 500; }
.card { padding: 24px; box-shadow: var(--shadow-2); }
.title { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 4px; }
.sub { font-size: 12.5px; color: var(--muted); line-height: 1.55; margin-bottom: 18px; }
.fields { display: flex; flex-direction: column; gap: 12px; }

.pw-wrap { position: relative; }
.pw-icon { position: absolute; left: 10px; top: 10px; color: var(--muted); }
.pw-input { padding-left: 32px; padding-right: 38px; height: 34px; }
.pw-eye { position: absolute; right: 4px; top: 4px; height: 26px; width: 26px; padding: 0; justify-content: center; }

.meter { display: flex; gap: 4px; margin-top: 8px; }
.meter .bar { flex: 1; height: 3px; border-radius: 2px; background: var(--border); }
.meter .bar.s1 { background: var(--danger); }
.meter .bar.s2 { background: var(--warn); }
.meter .bar.s3 { background: var(--warn); }
.meter .bar.s4 { background: var(--ok); }
.meter-label { font-size: 11px; color: var(--muted); margin-top: 6px; }
.lbl-s1 { color: oklch(0.85 0.18 22); }
.lbl-s2, .lbl-s3 { color: oklch(0.9 0.14 82); }
.lbl-s4 { color: oklch(0.88 0.14 155); }

.error {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 10px; border-radius: 6px;
  background: var(--danger-soft); border: 1px solid var(--danger-line);
  color: oklch(0.9 0.14 22); font-size: 12.5px;
}
.error svg { color: var(--danger); margin-top: 1px; flex-shrink: 0; }
.err-title { font-weight: 600; }
.err-body { color: var(--muted); margin-top: 2px; }

.submit { width: 100%; justify-content: center; height: 36px; }
.enter { margin-left: 6px; background: rgba(0,0,0,.2); border-color: rgba(0,0,0,.3); color: var(--accent-ink); }

.foot {
  display: flex; justify-content: space-between;
  font-size: 11.5px; color: var(--muted-2);
  padding: 0 4px;
}
</style>
