import { defineConfig } from "vitepress";

export default defineConfig({
  title: "herdr-workflows",
  description: "Short linear YAML workflows for herdr. Run commands, agents, and herdr calls.",
  base: "/herdr-workflows/",
  appearance: "dark",
  head: [
    ["link", { rel: "icon", href: "/herdr-workflows/favicon.svg", type: "image/svg+xml" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap",
      },
    ],
  ],
  // Inline `{{…}}` is workflow template syntax; fences already get v-pre.
  markdown: {
    config(md) {
      const render = md.renderer.rules.code_inline;
      if (!render) return;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        tokens[idx].attrSet("v-pre", "");
        return render(tokens, idx, options, env, self);
      };
    },
  },
  themeConfig: {
    siteTitle: "herdr-workflows",
    nav: [
      { text: "Install", link: "/install" },
      { text: "Guide", link: "/guide" },
      { text: "Run and manage", link: "/surfaces" },
      { text: "Examples", link: "/examples" },
      { text: "Reference", link: "/reference" },
    ],
    sidebar: [
      { text: "Install", link: "/install" },
      { text: "Write a workflow", link: "/guide" },
      { text: "Run and manage", link: "/surfaces" },
      { text: "Examples", link: "/examples" },
      { text: "Reference", link: "/reference" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/aorumbayev/herdr-workflows" }],
    search: { provider: "local" },
    outline: [2, 3],
    footer: {
      copyright:
        'Copyright © 2026 · <a href="https://github.com/aorumbayev/herdr-workflows/blob/main/LICENSE">MIT License</a>',
    },
  },
});
