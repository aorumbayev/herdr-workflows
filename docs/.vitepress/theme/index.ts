import DefaultTheme from "vitepress/theme";
import ExampleCards from "./ExampleCards.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: { component: (name: string, component: unknown) => void } }) {
    app.component("ExampleCards", ExampleCards);
  },
};
