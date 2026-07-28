---
layout: home

hero:
  name: herdr-workflows
  text: Workflows for your agentic terminal
  tagline: Short linear YAML — commands, managed agents, and explicit Herdr calls.
  actions:
    - theme: brand
      text: Guide
      link: /guide
    - theme: alt
      text: Examples
      link: /examples
    - theme: alt
      text: Reference
      link: /reference
---

## 60-second quickstart

```bash
herdr plugin install aorumbayev/herdr-workflows   # needs herdr ≥ 0.7.5
cd your-repo && hwf init
```

Write `.hwf/workflows/scratch.yaml`:

```yaml
version: v1alpha1
steps:
  - run: [lazygit]
    pane:
      open: tab
    background: true
```

Press `prefix+k`, pick `scratch`, hit enter — a lazygit tab opens.

Ready-made workflows (**handoff**, **prompt-enhance**) are on [Examples](/examples).
Each card copies a `hwf workflow import` command that shows the YAML and asks before writing.

Next: [Guide](/guide) · [Examples](/examples) · [Reference](/reference)
