---
layout: home

hero:
  name: herdr-workflows
  text: Workflows for your agentic terminal
  tagline: Short YAML sequences of shell, open, agent, and herdr steps — one keystroke.
  actions:
    - theme: brand
      text: Guide
      link: /guide
    - theme: alt
      text: Examples
      link: /examples
---

## 60-second quickstart

```bash
herdr plugin install aorumbayev/herdr-workflows   # needs herdr ≥ 0.7.5
cd your-repo && hwf init
```

Write `.hwf/workflows/scratch.yaml`:

```yaml
steps:
  - open: lazygit
```

Press `prefix+k`, pick `scratch`, hit enter — a lazygit tab opens. That's a workflow.

Next: [Guide](/guide) for the concepts · [Examples](/examples) for copy-paste recipes · [Reference](/reference) for every rule.
