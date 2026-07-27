# Donkey Docs

This folder is the product and engineering source of truth for capabilities that are already supported.

Donkey is a video editor. Donkey Cut runs in the browser; the Mac app is a menu bar
app that lets that page use the Mac's hardware — the local Cut engine for encoding,
storage, and speech-to-text, plus screen recording.

## Guides

Supported product and engineering guides live in `docs/guides/`. This list is the canonical index — keep it in sync when you add or rename a guide.

**The product**

- [Cut](guides/cut/README.md) — the video editor: what runs in the browser, what runs on the Mac, and the local resources behind it.
- [Cut's AI Assistant](guides/cut/ai-assistant.md) — how a chat turn runs: the providers, the tool bridge into the editor, what the model knows, and the context budgets.
- [Brief to Video](guides/cut/brief-to-video.md) — the director pipeline's strategy: story planning, the identity ladder that keeps a cast consistent, and where audio goes next.

**Site and backend**

- [Backend API Guide](guides/backend-apis.md) — the hosted routes the app and site call for model-backed work.
- [Frontend and Next.js Guidelines](guides/frontend-nextjs-guidelines.md) — route structure, server/client boundaries, styling, and data access in the site app.

**Operations**

- [Install Donkey Locally](guides/install-donkey.md) — building the app bundle and disk image for local testing.
- [Releasing Donkey](guides/releasing-donkey.md) — how production releases are built and shipped, including the tools that ship inside the app.

**Working in this repo**

- [Swift MVC Guide](guides/swift-mvc.md) — keeping product state, UI rendering, and AppKit orchestration separate in the app.
- [Code Review Guide](guides/code-review.md) — what makes a change reviewable, and how we review.
- [Engineering Doc Style Guide](guides/eng-doc-style.md) — the required structure, sentence-level rules, and post-writing test for every doc here.

Add or update an entry here when behavior becomes supported. Don't duplicate this index in subdirectories or app folders; link directly between related docs only when the relationship helps a maintainer. Write and edit docs following the [Engineering Doc Style Guide](guides/eng-doc-style.md).

## Navigation Rules

- Product guides should explain supported behavior, boundaries, and verification.
- Engineering guides should explain patterns current code must follow, not speculative architecture.
- Guides should not duplicate implementation. Prefer intent, rules, and concise source entrypoints over code listings or long file inventories.
- Register a new guide once, in the Guides index above; beyond that prefer one canonical file in `docs/` and selective cross-links only where they carry context.
