# Donkey UI checks

Read these checks when adding or changing UI. Resolve colors against the surface that actually paints behind them; opacity, portals, images, and state overrides can change that surface.

## Surfaces and primitives

The site theme lives in [globals.css](../../../../site/src/app/globals.css). `background/foreground`, `card/card-foreground`, `popover/popover-foreground`, `primary/primary-foreground`, `secondary/secondary-foreground`, and `accent/accent-foreground` are pairs. `muted-foreground`, `border`, `input`, `ring`, and `destructive` serve their named roles; inspect their rendered contrast for the new use.

The root uses the system preference until an explicit `.light` or `.dark` theme is set. Product `.app-surface` pages select `--app-background`, while public light pages use the sand background. Cold-load both kinds of surface. Check explicit light on a dark system and explicit dark on a light system when touching theme selection; exercise a preference change while the page is open.

`ink`, `cream`, and `coral` are fixed brand colors. Pair fixed pastel cards with their intended ink. [Note paper](../../../../site/src/cut/components/notePaper.css) retains stored palette indices, uses muted card tints in dark mode, and adapts named text colors. Verify the sheet, tiles, and portaled menus.

Use [Button](../../../../site/src/components/ui/button.tsx), Input, Dialog, Popover, and DropdownMenu from the same UI directory. They carry focus, invalid, disabled, expanded, portal, and positioning behavior. Compose with `cn` and Tailwind responsive variants. Feature CSS belongs beside its owner; inline styles carry genuinely runtime values, such as data-derived CSS variables.

```tsx
// Failure: fixed ink disappears on a theme-dependent dark card.
<button className="bg-card text-ink">Save</button>

// Pair the action colors; preserve primitive focus and disabled behavior.
<Button disabled={saving} aria-busy={saving}>Save</Button>

// Pair the surface and its content; choose hint contrast on this surface.
<section className="border border-border bg-card text-card-foreground">
  <p className="text-muted-foreground">Choose a file</p>
</section>
```

For the donkey mark, reuse [DonkeyMark](../../../../site/src/components/DonkeyMark.tsx); dark mode sets it on a white tile. For native UI, use the platform's semantic colors and existing controls, then apply the same state and evidence matrix.

## State matrix

Run each applicable row in both themes at a wide desktop viewport and a narrow supported viewport. Test around the component's actual responsive breakpoint, short height, long labels, and 200% zoom. Record actual viewport dimensions. Preserve `embed=chatgpt` visibility gates when the affected UI is embedded.

| State | Action and observable result |
| --- | --- |
| Default | Read labels, body, hints, icons, and meaningful boundaries on every surface. Inspect inline code, links, images, and prose inversion. |
| Hover | Move onto text, icon, and nested action; check the final background/foreground pair and stable dimensions. |
| Focus | Tab and Shift+Tab through controls; ring stays visible and unclipped. Enter/Space activates the expected action. |
| Disabled | Reach the prerequisite that disables the action; activation stays blocked and the reason remains understandable. |
| Selected | Toggle the state; check selected text/icon/border and `aria-pressed`, `aria-selected`, or checked semantics appropriate to the control. |
| Error | Trigger a safe validation failure; show an error message and connect it with `aria-describedby` and `aria-invalid` where appropriate. |
| Loading | Use a controlled pending fixture; the skeleton, label, progress, and cancellation remain understandable without layout jumps. |
| Empty | Use zero items; the explanation and available next action remain readable. |

Use labels for inputs and accessible names for icon-only controls; a tooltip supplements the name. Use the native element or existing primitive for its role. Confirm dialog title, focus entry, Escape dismissal where appropriate, focus containment, and return to the trigger. Arrow-key menu navigation must agree with its roles. Communicate errors, selection, and chart series through text or shape as well as color.

## Contrast measurement

Use the browser's computed foreground/background values and include opacity and every translucent ancestor. Resolve transparent surfaces to the painted background; include scrims and image regions under text. Inspect computed placeholder, hover, focus, and selected styles as separate samples. Measure with the available browser contrast tooling or a luminance calculation; record the sampled pair and ratio when contrast is at issue.

The [WCAG text target](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) is 4.5:1 for normal text, including hints and hover text; large text uses 3:1 (24 CSS px regular or 18.67 CSS px bold). [Essential control/graphic indicators](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) use 3:1 against adjacent colors. Inactive controls have a contrast exception; keep their purpose and disabled explanation usable. Decorative separators need no arbitrary contrast increase. Check [visible keyboard focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) on the adjacent surfaces. Existing tokens and screenshots support inspection; neither establishes a whole-page accessibility pass.

```tsx
// Failure: a hover override can break an otherwise readable pair.
<Button variant="ghost" className="hover:text-ink">Continue</Button>

// The primitive pairs hover foreground/background in both themes.
<Button variant="ghost">Continue</Button>

// Failure: no keyboard role, focus behavior, or accessible name.
<div onClick={onClose}><X /></div>

<Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}>
  <X aria-hidden="true" />
</Button>
```

## Overlays, charts, and canvas

Open portaled menus and modals through their triggers. Inspect the portal root: note-paper inheritance and a local theme wrapper may stop at the portal boundary. Shared Dialog uses `bg-popover text-popover-foreground`; keep its scrolling body and positioner so small heights remain usable. Inspect tooltips, nested menus, selected options, validation messages, and backdrops separately.

Canvas pixels and chart library fills do not inherit text utilities. Inspect the actual renderer and its palette; this repo has no shared `ui/chart` primitive to assume. Check axes, tick labels, legend, tooltip, selected series, grid boundaries needed to read data, and empty/loading results. Repaint a theme-dependent renderer after a theme change without adding per-frame style reads. Preserve intentional media colors in the preview and exported artwork; theme the surrounding editor chrome. Provide accessible DOM controls and an equivalent text/table summary for data that only the drawing conveys. Preview/timeline rendering changes run the performance checks required by AGENTS.md.

## Evidence

Capture the rendered state after it settles, including keyboard focus and opened overlays. A useful record looks like:

```text
Route           Theme   Viewport  State       Result       Evidence
/app/library    dark    1280x800  empty       checked      library-dark-empty.jpg
/app/library    light   390x844   error       not tested   backend unavailable
```

Use route templates and data-state labels to define coverage; one example slug does not cover every article or project. Next may retain hidden routes in React Activity, so a document-wide scan must filter for actual visibility. A skeleton capture establishes only the loading state. Summaries name untested themes, states, viewports, residencies, real integrations, and fixture limitations. Review screenshots for names, email addresses, project media, browser chrome, tokens, and notifications before publishing; attach evidence with captions and explicit exceptions.
