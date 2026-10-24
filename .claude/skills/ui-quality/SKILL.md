---
name: ui-quality
description: Build or revise Donkey UI with readable light and dark states, accessible controls, and review evidence. Use for UI additions, styling changes, and UI bug fixes.
---

# UI Quality

Every UI change works in light and dark mode, including its interactive and data states. A token name alone does not prove that the rendered foreground is readable on its surface.

Before editing, read the applicable frontend or native guide under `docs/guides/` and [the checks and examples](references/checks.md). For site work, inspect `site/src/app/globals.css` and the existing primitive under `site/src/components/ui/` before composing a new control. Keep the repository's data-access, styling, performance, and testing rules.

```text
surface + states + affected routes
  ↓
existing tokens + primitives
  ↓
light/dark + keyboard + viewport checks
  ↓
screenshots + measured results + explicit gaps
```

Record a small matrix for the affected surface: theme, viewport, UI state, route/data fixture, result, and screenshot. Exercise default, hover, focus, disabled, selected, error, loading, and empty states where the feature has them. Explain inapplicable cells. Check cold loads, navigation, and opened overlays; shared components need representative consumers on different surfaces.

Fix regressions with a failing test before the fix. Use the repository's relevant tests, lint, and build; a class assertion supplements rendered checks. Retain results for the tested revision and rerun affected checks after changes. Disclose missing credentials, unavailable services, skipped states, and untested residencies in the PR. A loading shell is a loading-state result; a ready-state result requires ready content.

Keep screenshots with route, theme, viewport, and state labels. Use anonymous fixtures or approved public content, inspect captures for private data, and attach the evidence to the review destination authorized by the user. This skill grants no publishing or account permissions.
