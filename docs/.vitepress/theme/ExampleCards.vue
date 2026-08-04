<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import examples from "./examples.generated";

const open = ref("");
const copied = ref("");

function command(card) {
  return `hwf workflow import "${card.payload}"`;
}

async function copy(card) {
  await navigator.clipboard.writeText(command(card));
  copied.value = card.name;
  setTimeout(() => {
    if (copied.value === card.name) copied.value = "";
  }, 2000);
}

function show(name) {
  open.value = name;
}

function close() {
  open.value = "";
}

function onKeydown(event) {
  if (event.key === "Escape") close();
}

watch(open, (value) => {
  if (typeof document === "undefined") return;
  if (value) {
    document.addEventListener("keydown", onKeydown);
    document.body.style.overflow = "hidden";
  } else {
    document.removeEventListener("keydown", onKeydown);
    document.body.style.overflow = "";
  }
});

onBeforeUnmount(() => {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
});
</script>

<template>
  <div class="hwf-cards">
    <article v-for="card in examples" :key="card.name" class="hwf-card">
      <header>
        <h3>{{ card.name }}</h3>
        <p>{{ card.desc }}</p>
      </header>
      <p class="hwf-file">
        <code>{{ card.name }}.yaml</code>
      </p>
      <div class="hwf-actions">
        <button type="button" class="hwf-copy" @click="copy(card)">
          {{ copied === card.name ? "copied ✓" : "copy import command" }}
        </button>
        <button type="button" class="hwf-peek" @click="show(card.name)">show YAML</button>
      </div>
    </article>

    <Teleport to="body">
      <template v-for="card in examples" :key="`modal-${card.name}`">
        <div
          v-if="open === card.name"
          class="hwf-modal-overlay"
          role="dialog"
          aria-modal="true"
          :aria-label="`${card.name}.yaml`"
          @click.self="close"
        >
          <div class="hwf-modal">
            <header class="hwf-modal-head">
              <code>{{ card.name }}.yaml</code>
              <button type="button" class="hwf-modal-close" aria-label="Close" @click="close">
                ✕
              </button>
            </header>
            <pre class="hwf-modal-yaml">{{ card.body.trimEnd() }}</pre>
          </div>
        </div>
      </template>
    </Teleport>
  </div>
</template>

<style scoped>
.hwf-cards {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  margin: 1.5rem 0;
}
.hwf-card {
  border: 1px solid var(--line, var(--vp-c-divider));
  border-radius: var(--radius-md, 4px);
  padding: 1rem;
  background: var(--bg-elevated, var(--vp-c-bg-soft));
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.hwf-card h3 {
  margin: 0;
  font-family: var(--mono, var(--vp-font-family-mono));
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.hwf-card header p {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: var(--muted, var(--vp-c-text-3));
  line-height: 1.45;
}
.hwf-file {
  margin: 0;
}
.hwf-file code {
  font-size: 0.72rem;
}
.hwf-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: auto;
  flex-wrap: wrap;
}
.hwf-actions button {
  border: 1px solid var(--line-strong, var(--vp-c-border));
  border-radius: var(--radius-md, 4px);
  padding: 0.4rem 0.7rem;
  font-family: var(--mono, var(--vp-font-family-mono));
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--ink-soft, var(--vp-c-text-2));
  background: transparent;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease,
    background 0.12s ease;
}
.hwf-actions button:hover {
  border-color: var(--accent, var(--vp-c-brand-1));
  color: var(--accent, var(--vp-c-brand-1));
  background: var(--accent-soft, var(--vp-c-brand-soft));
}
.hwf-copy {
  background: var(--ink);
  color: var(--bg);
  border-color: transparent;
}
.hwf-copy:hover {
  background: var(--accent, var(--vp-c-brand-1));
  color: var(--on-accent);
  border-color: transparent;
}
.hwf-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  background: color-mix(in srgb, var(--vp-c-bg) 35%, rgba(0, 0, 0, 0.55));
  backdrop-filter: blur(2px);
}
.hwf-modal {
  display: flex;
  flex-direction: column;
  width: fit-content;
  min-width: min(28rem, 92vw);
  max-width: min(60rem, 92vw);
  max-height: 85vh;
  border: 1px solid var(--line-strong, var(--vp-c-border));
  border-radius: var(--radius-lg, 8px);
  background: var(--bg-elevated, var(--vp-c-bg-soft));
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.hwf-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--line, var(--vp-c-divider));
}
.hwf-modal-head code {
  font-size: 0.78rem;
  background: transparent;
  padding: 0;
}
.hwf-modal-close {
  border: 1px solid var(--line-strong, var(--vp-c-border));
  border-radius: var(--radius-sm, 3px);
  background: transparent;
  color: var(--ink-soft, var(--vp-c-text-2));
  font-size: 0.75rem;
  line-height: 1;
  padding: 0.35rem 0.5rem;
  cursor: pointer;
}
.hwf-modal-close:hover {
  border-color: var(--accent, var(--vp-c-brand-1));
  color: var(--accent, var(--vp-c-brand-1));
  background: var(--accent-soft, var(--vp-c-brand-soft));
}
.hwf-modal-yaml {
  margin: 0;
  padding: 0.85rem 1rem;
  overflow: auto;
  background: var(--code-bg, var(--vp-code-bg));
  font-size: 0.78rem;
  line-height: 1.45;
}
</style>
