## Why

An input prompt states the input's name and how to operate the widget, so a dropdown of sixty-seven
git references reads as an unexplained list. The prompt already renders an author description when
one exists, but nothing tells the user which prompt they are on, what earlier answers narrowed the
list, how large the domain is, or that a custom value is accepted. Authors cannot fix the parts that
are structural rather than descriptive.

## What Changes

- State the prompt's position in the collection as an ordinal, counted over answered active inputs.
- Render the answers collected so far beneath the prompt, truncated to the content width.
- Report the resolved option count for a closed domain, and say when a custom value is accepted.
- Report a text input's default and any `min_length` floor in the prompt.
- Leave the workflow title, source, description rendering, list viewport, and footer hints unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `picker-presentation`: Add prompt self-description requirements for input collection.

## Impact

The change affects `src/tui/picker.ts` prompt formatting and its tests. No parser, loader, runner,
CLI, or payload behavior changes. Workflow YAML is unaffected; authors who already set input
descriptions see them in the same position.
