# Swift Guide

How to write Swift for the iOS and Mac apps in this repo: the MVC split,
language defaults, concurrency, SwiftUI, platform behavior, data, and tests.

**The one rule:** `DonkeyUI` never imports `DonkeyRuntime`. Runtime work
reaches a view only as data its model passes in, never through view internals.

## The MVC Split

Product state, UI rendering, and AppKit orchestration stay separate, so the
app's UI stays easy to change without coupling it to runtime work.

- Model owns observable product state and intent handling.
- View renders state and emits typed intents.
- Controller owns AppKit lifecycle, windows, timers, geometry, and side effects.
- App entry wires the first model and controller, then gets out of the way:
  `@main`, delegate adaptation, and little else.

Prefer target-level separation for reusable UI and runtime work: `DonkeyUI`
holds views, `DonkeyRuntime` holds the engine supervisor, bundled tools, and
the recorder. Name files after their MVC role when a feature grows past one
screen: `FeatureModel.swift`, `FeatureRootView.swift`,
`FeatureController.swift`.

Screen recording follows this split: the recorder and its destination types
hold the capture state; the control bar view renders it; controllers own the
AppKit-only work such as the control bar panel, the region and window pickers,
and screen positioning; the app delegate bootstraps the feature and the menu
bar without owning product behavior. The stream draws the pointer straight
into the video.

## Language

- Model data as structs and enums. Reserve classes for identity, shared mutable
  state, and framework requirements.
- Make illegal states unrepresentable. An enum with associated values beats a
  struct of optionals that are never both nil: `case loading`,
  `case loaded(Data)`, `case failed(Error)`.
- Handle optionals honestly: `guard let` for early exit, `if let` for
  branching, `??` for defaults. Force-unwrap only where nil is a programmer
  error worth crashing on, such as a bundled resource.
- Errors are typed control flow: `throws` and `do/catch`, with a small error
  enum per subsystem.
- `let` until the compiler demands `var`.
- Define a protocol where a seam needs testing or multiple conformers exist.
  Write `some Protocol` by default; `any Protocol` only for heterogeneous
  values. Models may depend on narrow provider protocols.
- Name methods so call sites read as phrases: `list.insert(element, at: index)`.

## Concurrency

- Stay on the main actor and leave it deliberately. Projects set default actor
  isolation to the main actor, so views, models, and helpers agree by
  construction — models publishing UI state and controllers touching AppKit
  are covered with zero annotations.
- Mark CPU-heavy async work `@concurrent` to move it off the main actor:
  parsing, image work, encoding.
- Use an actor for mutable state hit from many tasks: caches, download
  managers, database handles.
- Prefer structured work — `async let`, task groups, and `.task {}` on views —
  so cancellation propagates. Long loops call `Task.checkCancellation()`.
- New event streams use AsyncSequence.

## SwiftUI

- Keep views value-like: pass state in, pass typed intent sinks out. Timers,
  global mouse reads, model providers, and window management belong in
  controllers.
- State lives in `@Observable` classes. The view that creates a model owns it
  with `@State`; app-wide services inject with `@Environment`; write access to
  someone else's state passes as `@Binding` or `@Bindable`.
- Models import Foundation only. A SwiftUI or AppKit import in a model means
  view or controller concerns leaked in, and it costs headless testability.
- Navigation: `NavigationStack` with typed path values for drill-down;
  `NavigationSplitView` for sidebar layouts, which collapse to a stack on
  iPhone.
- When SwiftUI runs out — heavy custom text, camera or Metal surfaces — wrap
  the smallest possible AppKit or UIKit view in a representable and keep the
  SwiftUI shell.

## The Mac Is Its Own Platform

Share models and feature logic across platforms; split views where behavior
diverges. Keep `#if os(macOS)` out of feature logic — a shared model driving a
Mac view and an iOS view beats one view full of conditionals.

Mac users expect:

- Every meaningful action in the menu bar with a keyboard shortcut, via
  `.commands`.
- The standard scenes: `Settings` for preferences, `Window` for singletons,
  `MenuBarExtra` for status-bar presence.
- Keyboard-first flows: focus, `.keyboardShortcut`, arrow keys through
  `onMoveCommand`, Escape to cancel.
- Desktop density: sidebars, tables, inspectors, hover states, drag and drop
  through Transferable.

## Data

- Small preferences use `@AppStorage`; secrets go in the Keychain.
- Keep any store behind a small repository type the rest of the app talks to.
  Feature-layer models stay plain structs; persistence types stay at the edge.
- Network with URLSession, async/await, and Codable. Decode at the boundary
  into domain types; wire formats never leak past the client layer.

## Tests

- Write new tests with Swift Testing: `@Test` functions, `#expect` for soft
  failures, `#require` to abort, arguments for parameterized cases.
- Test models and services headlessly — the payoff of keeping UI frameworks
  out of them. UI correctness comes from previews plus a thin set of UI tests
  on critical flows.
- Tests run in parallel by default. When that surfaces shared state, fix the
  state.

## Review Checklist

- A SwiftUI view does not call `NSEvent.mouseLocation`, create an `NSPanel`,
  start a `Timer`, or import `DonkeyRuntime`.
- A model does not import `DonkeyUI`.
- A model does not know about frames, screens, windows, or animation timing.
- A controller does not store business text or decide model-provider behavior
  beyond presenting existing model state.
- New product behavior adds or extends a guide in `docs/guides/`.
