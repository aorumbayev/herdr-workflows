import { defineConfig } from "vitepress";

export default defineConfig({
  title: "herdr-workflows",
  description: "Linear YAML workflow runner for herdr",
  base: "/herdr-workflows/",
  appearance: "force-dark",
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
    nav: [
      { text: "Guide", link: "/guide" },
      { text: "Examples", link: "/examples" },
      { text: "Reference", link: "/reference" },
    ],
    sidebar: [
      { text: "Guide", link: "/guide" },
      { text: "Examples", link: "/examples" },
      { text: "Reference", link: "/reference" },
    ],
    search: { provider: "local" },
    outline: [2, 3],
  },
});
