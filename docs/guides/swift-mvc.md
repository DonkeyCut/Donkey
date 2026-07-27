# Swift MVC Guide

Donkey Swift code keeps product state, UI rendering, and AppKit orchestration
separate, so the app's UI stays easy to change without coupling it to runtime
work. Views render and emit typed intents; models own state;
controllers own AppKit.

**The one rule:** `DonkeyUI` never imports `DonkeyRuntime`.
Runtime work reaches a view only as data its model passes in, never through
view internals.

## Pattern

- Model owns observable product state and intent handling.
- View renders state and emits typed intents.
- Controller owns AppKit lifecycle, windows, timers, geometry, and side effects.
- App entry wires the first model and controller, then gets out of the way.

## Technical Guidelines

- Keep SwiftUI views value-like: pass state in, pass typed intent sinks out,
  and avoid timers, global mouse reads, model providers, or window management
  inside views.
- Keep models on `@MainActor` when they publish UI state. Models may depend on
  narrow provider protocols, but not on AppKit windows or timers.
- Keep controllers on `@MainActor` when they touch AppKit. Controllers may read
  screen and event geometry, monitor double-Command activation, own `NSPanel`,
  and translate geometry into model state.
- Keep app entry files small: `@main`, delegate adaptation, and little else.
- Prefer target-level separation for reusable UI and runtime work: `DonkeyUI`
  holds views, `DonkeyRuntime` holds the engine supervisor, bundled tools, and
  the recorder.
- Name files after their MVC role when a feature grows past one screen:
  `FeatureModel.swift`, `FeatureRootView.swift`, `FeatureController.swift`.

## Current Donkey Shape

Screen recording follows this split: `ScreenRecorder` and its destination types
hold the capture state; `RecordingControlBarView` renders it; the controllers own
AppKit-only work such as the control bar panel, the region and window pickers, and
screen positioning; `DonkeyAppDelegate` bootstraps the feature and the menu bar
without owning product behavior.

## Review Checklist

- A SwiftUI view does not call `NSEvent.mouseLocation`, create an `NSPanel`,
  start a `Timer`, or import `DonkeyRuntime`.
- A model does not import `DonkeyUI`.
- A model does not know about frames, screens, windows, or animation timing.
- A controller does not store business text or decide model-provider behavior
  beyond presenting existing model state.
- New product behavior adds or extends a guide in `docs/guides/`.
