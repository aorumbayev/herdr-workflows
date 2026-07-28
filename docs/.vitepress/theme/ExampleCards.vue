<script setup>
import { ref } from "vue";
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

function toggle(name) {
  open.value = open.value === name ? "" : name;
}
</script>

<template>
  <div class="hwf-cards">
    <article v-for="card in examples" :key="card.name" class="hwf-card">
      <header>
        <h3>{{ card.name }}</h3>
        <p>{{ card.desc }}</p>
      </header>
      <p class="hwf-files">
        <code v-for="f in card.files" :key="f.name">{{ f.name }}.yaml</code>
      </p>
      <div class="hwf-actions">
        <button type="button" class="hwf-copy" @click="copy(card)">
          {{ copied === card.name ? "copied ✓" : "copy import command" }}
        </button>
        <button type="button" class="hwf-peek" @click="toggle(card.name)">
          {{ open === card.name ? "hide YAML" : "show YAML" }}
        </button>
      </div>
      <div v-if="open === card.name" class="hwf-yaml">
        <div v-for="f in card.files" :key="f.name">
          <p class="hwf-filename">{{ f.name }}.yaml</p>
          <pre>{{ f.body.trimEnd() }}</pre>
        </div>
      </div>
    </article>
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
.hwf-files {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.hwf-files code {
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
  background: var(--ink, #fff);
  color: var(--bg, #2e3440);
  border-color: transparent;
}
.hwf-copy:hover {
  background: var(--accent, var(--vp-c-brand-1));
  color: #fff;
  border-color: transparent;
}
.hwf-yaml {
  overflow-x: auto;
}
.hwf-filename {
  margin: 0.5rem 0 0.2rem;
  font-family: var(--mono, var(--vp-font-family-mono));
  font-size: 0.72rem;
  color: var(--muted, var(--vp-c-text-3));
}
.hwf-yaml pre {
  margin: 0;
  padding: 0.6rem;
  border: 1px solid var(--line, var(--vp-c-divider));
  border-radius: var(--radius-md, 4px);
  background: color-mix(in srgb, var(--bg, var(--vp-c-bg)) 80%, #000);
  font-size: 0.72rem;
  line-height: 1.4;
  overflow-x: auto;
}
</style>
