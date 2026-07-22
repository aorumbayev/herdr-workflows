import { defineConfig } from "vitepress";

export default defineConfig({
  title: "herdr-workflows",
  description: "Linear YAML workflow runner for herdr",
  base: "/herdr-workflows/",
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
