<script setup>
import { ref } from "vue";
import { withBase } from "vitepress";
import workbench from "../../assets/workbench.svg";

const copied = ref("");

async function copy(key, text) {
  await navigator.clipboard.writeText(text);
  copied.value = key;
  setTimeout(() => {
    if (copied.value === key) copied.value = "";
  }, 1600);
}

const installCmd = "herdr plugin install aorumbayev/herdr-workflows";
const initCmd = "hwf init";
</script>

<template>
  <div class="home">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow"><span class="dot" aria-hidden="true" /> herdr plugin · linear yaml</p>
        <h1>Workflows for the herd.</h1>
        <p class="lede">
          Short YAML that runs commands, managed agents, and explicit Herdr calls — from the picker,
          CLI, or workbench.
        </p>
        <div class="actions">
          <a class="btn btn-primary" href="#install">Quick start</a>
          <a class="btn btn-secondary" :href="withBase('/guide')">Read the guide</a>
        </div>
        <p class="note">Needs herdr ≥ 0.7.5 · no Electron, no account · MIT</p>
      </div>
      <!-- object, not img: the chapter buttons inside the SVG only work when its script runs -->
      <div class="hero-shot">
        <object
          type="image/svg+xml"
          :data="workbench"
          aria-label="herdr-workflows in five chapters — animated walkthrough"
        >
          <img :src="workbench" alt="herdr-workflows in five chapters" />
        </object>
      </div>
    </section>

    <section id="install" class="install">
      <p class="kicker">get running</p>
      <h2>Install, init, run</h2>
      <p class="section-lede">Three commands. Then <code>prefix+k</code> opens the picker.</p>

      <div class="install-stack">
        <div class="install-card">
          <span class="prompt">$</span>
          <code>{{ installCmd }}</code>
          <button type="button" @click="copy('install', installCmd)">
            {{ copied === "install" ? "copied" : "Copy" }}
          </button>
        </div>
        <div class="install-card secondary">
          <span class="prompt">$</span>
          <code>cd your-repo && {{ initCmd }}</code>
          <button type="button" @click="copy('init', `cd your-repo && ${initCmd}`)">
            {{ copied === "init" ? "copied" : "Copy" }}
          </button>
        </div>
      </div>

      <div class="scratch">
        <p class="scratch-label"><code>.hwf/workflows/scratch.yaml</code></p>
        <pre class="scratch-code"><code>version: v1alpha1
steps:
  - run: [lazygit]
    pane:
      open: tab
    background: true</code></pre>
        <p class="scratch-hint">
          Press <code>prefix+k</code>, pick <code>scratch</code>, hit enter — a lazygit tab opens.
        </p>
      </div>
    </section>

    <section class="surfaces">
      <p class="kicker">surfaces</p>
      <h2>Pick how you work</h2>
      <div class="surface-grid">
        <article>
          <h3>prefix+k</h3>
          <p>
            Picker runs workflows; list-mode <code>Ctrl+E</code> / <code>Ctrl+Y</code> /
            <code>Ctrl+O</code> open edit, share, or import in the workbench.
          </p>
        </article>
        <article>
          <h3>hwf run</h3>
          <p>Same runner from the terminal or scripts, with <code>--input k=v</code>.</p>
        </article>
        <article>
          <h3>hwf web</h3>
          <p>Browser workbench to build, validate, share, and import — never executes.</p>
        </article>
      </div>
    </section>

    <section class="examples">
      <p class="kicker">from the herd</p>
      <h2>Ready-made workflows</h2>
      <p class="section-lede">
        <strong>handoff</strong> and <strong>prompt-enhance</strong> ship in <code>examples/</code>.
        Each card copies a reviewed <code>hwf workflow import</code> bundle command.
      </p>
      <div class="actions">
        <a class="btn btn-primary" :href="withBase('/examples')">Browse examples</a>
        <a class="btn btn-secondary" :href="withBase('/reference')">Reference</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 1160px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 4rem;
}

/* the walkthrough carries 12px terminal type — it needs the full column to stay readable */
.hero {
  display: grid;
  gap: 2rem;
  padding: 1.5rem 0 2.75rem;
}

.eyebrow,
.kicker {
  margin: 0 0 1rem;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
}

.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--green);
  flex: 0 0 auto;
}

.hero h1,
.install h2,
.surfaces h2,
.examples h2 {
  margin: 0;
  color: var(--ink);
  font-family: var(--mono);
  font-weight: 400;
  letter-spacing: -0.04em;
  line-height: 1.08;
  text-wrap: balance;
}

.hero h1 {
  font-size: clamp(2.4rem, 5vw, 3.8rem);
  max-width: 14ch;
}

.lede,
.section-lede {
  max-width: 36rem;
  margin: 1.1rem 0 0;
  color: var(--ink-soft);
  font-size: 1.05rem;
  line-height: 1.6;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-top: 1.5rem;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.6rem;
  padding: 0.55rem 1.1rem;
  border-radius: var(--radius-md);
  font-family: var(--mono);
  font-weight: 600;
  font-size: 0.9rem;
  border: 1px solid transparent;
  text-decoration: none;
  transition:
    color 0.12s ease,
    background 0.12s ease,
    border-color 0.12s ease;
}

.btn-primary {
  background: var(--ink);
  color: var(--bg);
}

.btn-primary:hover {
  background: var(--accent);
  color: #fff;
}

.btn-secondary {
  background: transparent;
  border-color: var(--line-strong);
  color: var(--ink-soft);
}

.btn-secondary:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.note {
  margin: 1rem 0 0;
  color: var(--muted-2);
  font-family: var(--mono);
  font-size: 0.78rem;
}

.hero-shot {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  overflow: hidden;
  box-shadow: 0 18px 50px color-mix(in srgb, #000 28%, transparent);
}

.hero-shot object,
.hero-shot img {
  display: block;
  width: 100%;
  aspect-ratio: 1200 / 720;
  height: auto;
}

.install,
.surfaces,
.examples {
  padding: 2.25rem 0 0;
  border-top: 1px solid var(--line);
  margin-top: 0.5rem;
}

.install h2,
.surfaces h2,
.examples h2 {
  font-size: clamp(1.5rem, 3vw, 2rem);
}

.install-stack {
  display: grid;
  gap: 0.45rem;
  max-width: 40rem;
  margin-top: 1.15rem;
}

.install-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 0.85rem;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-elevated) 88%, #000);
  border: 1px solid var(--line);
}

.install-card.secondary {
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
}

.prompt {
  color: var(--accent);
  font-family: var(--mono);
  font-weight: 700;
}

.install-card code {
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
  font-size: 0.82rem;
  color: var(--ink-soft);
  background: transparent;
  border: 0;
  padding: 0;
}

.install-card code::-webkit-scrollbar {
  display: none;
}

.install-card button {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--ink-soft);
  cursor: pointer;
  padding: 0.3rem 0.65rem;
  font-family: var(--mono);
  font-size: 0.72rem;
  font-weight: 600;
}

.install-card button:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.scratch {
  margin-top: 1.35rem;
  max-width: 40rem;
}

.scratch-label {
  margin: 0 0 0.45rem;
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
}

.scratch-code {
  margin: 0;
  padding: 0.85rem 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-elevated) 88%, #000);
  overflow-x: auto;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--ink-soft);
}

.scratch-hint {
  margin: 0.85rem 0 0;
  color: var(--ink-soft);
  line-height: 1.55;
}

.scratch-hint code,
.section-lede code,
.surface-grid code {
  font-size: 0.85em;
}

.surface-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.85rem;
  margin-top: 1.25rem;
}

.surface-grid article {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
}

.surface-grid h3 {
  margin: 0;
  font-family: var(--mono);
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.surface-grid p {
  margin: 0.45rem 0 0;
  color: var(--muted);
  font-size: 0.9rem;
  line-height: 1.5;
}

.examples .section-lede strong {
  color: var(--ink);
  font-weight: 600;
}

@media (max-width: 900px) {
  .hero {
    padding-top: 0.75rem;
  }

  .hero h1 {
    max-width: none;
  }

  .surface-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .hero-copy,
  .hero-shot,
  .install,
  .surfaces,
  .examples {
    animation: rise 0.45s ease both;
  }

  .hero-shot {
    animation-delay: 0.06s;
  }

  .install {
    animation-delay: 0.1s;
  }

  .surfaces {
    animation-delay: 0.14s;
  }

  .examples {
    animation-delay: 0.18s;
  }
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
