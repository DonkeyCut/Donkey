# Agent Guide

Donkey is a video editor. Donkey Cut runs in the browser; the Mac app is a menu bar app
whose only job is to let that page use the Mac's hardware — the local Cut engine (encoding,
storage, speech-to-text) and screen recording.

`docs/` holds supported product behavior and engineering guidance. Start with `docs/README.md`
when changing supported behavior.

Never infer semantic intent by string matching raw user input. Do not add phrase lists, prefixes, suffixes, regexes, app-name checks, greeting/help classifiers, or other natural-language command-text matching to decide what the user wants. Raw user text has too many variations to handle reliably. Pass the turn through an LLM or another typed model/runtime boundary first, get structured output, then do deterministic matching only on that structured output or on non-semantic technical fields.

## Performance

Performance comes first. Everything we ship has to be fast on the machines people edit on, and a change that makes the preview, the timeline, or the app slower is a regression whatever else it adds.

- Work scales with what is on screen and what the person is doing, never with the size of the project. Draw and decode the visible part, queue the rest behind it, and skip what nothing shows.
- Keep the main thread and the frame loop clear: one animation frame per tick, no synchronous decodes or layout reads inside a hot path, no allocation per frame.
- Every cache is bounded in bytes through the memory budget (`site/src/cut/lib/memoryBudget.ts`), and every reader, decoder and canvas is closed by the code that opened it.
- Measure. A preview or timeline change runs the perf evals (`npm run eval:cut-perf`, `eval:cut-perf-lowend`) before it ships, and the summary says what moved.

## Site Project

Before changing `site/` UI, routes, API handlers, or data access patterns:

- Read the relevant Next.js guide in `site/node_modules/next/dist/docs/`; this version may differ from your training data.
- Read the applicable site guidance in `docs/guides/`.
- Do not hand-write SQL migrations.
- Do not run database migrations, including `prisma migrate`, `prisma db push`, or any command that applies schema changes to Supabase or another database.
- Keep Prisma table/model definitions out of `site/prisma/schema.prisma`. Put tables in logically grouped sibling `.prisma` files under `site/prisma/`; reserve `schema.prisma` for shared Prisma configuration such as generator and datasource blocks.
- Treat `/prototype`, "the prototype route", or route-shaped prototype requests as work on the Next.js route under `site/`, not as a repository-root `prototype/` directory.

## Cut Surfaces

Every Cut change has to hold on all four surfaces, and the plan for it says how:

- **Three residencies.** A project lives in the **browser** (OPFS in the page), on this **Mac** (the Bun engine inside the app, with the bundled command-line tools), or in the **cloud** (Postgres doc + R2 media, the work done by the container worker). People run all three — a Mac with or without the app, any browser, a cloud project — so a change holds in each of them. Work through the backend seam in `site/src/cut/lib/backend/`. Where one residency lacks the machinery for a job, hand the job to one that has it: the browser shelf imports links through the cloud worker, and the engine falls back to the same worker when its own tools come back empty-handed.
- **Headed and headless.** Whatever the tab can do, the Bun engine and the worker runner can do: chat tools, rendering, media reads. Headless installs browser primitives — canvas, decoders, Web Audio, fonts — behind narrow seams (`lib/raster.ts`, the frame sink in `lib/mediaRead.ts`, the font installer in `lib/fontAssets.ts`, the kit's `surface.ts`) so one implementation serves both; reach for those seams before writing a second path.
- Allocate canvases and decode images through the raster seam. Direct `document`, `window`, `FileReader`, `createImageBitmap`, or `FontFace` use in `site/src/cut/lib/` or `packages/effects-kit/` breaks a job.
- When a surface genuinely cannot carry a feature, give it a fallback and say so in the summary and the guide.
- **The AI chat drives it too.** A functional change ships with its chat surface: a tool the assistant can call, and descriptions/system-prompt lines that teach the new capability. Derive tool schemas and prompt text from the same exported constants the UI uses (style id lists, model registries) so the catalog updates itself; check the tool files beside the component (`*.tools.ts`) and `site/src/cut/server/ai/catalog.ts`.
- The chat surface is kept true, both directions. Removing or reshaping a feature means deleting its tool and its prompt/skill mentions in the same change — grep the catalog, the `*.tools.ts` files, the skills library, and `lib/aiTools.ts` for the old names, ids, and parameters. A tool that describes behavior the code no longer has, offers an option that no longer exists, or is missing a setting the UI gained is a bug: the model calls what the catalog teaches.

## Working Rules

- Do not touch repository-root `prototype/` unless the user explicitly asks for that filesystem path. By default, assume requested product changes are for the Mac app or the site/landing page.
- Ask before creating any new plan document.
- Code reviews run on the latest Opus model; fixes and implementation run on the latest Fable model. Make the switch yourself: a review request (`/code-review`, "review this") runs in an agent with `model: "opus"` whatever the session model is, and a fix runs on Fable, spawned in an agent with `model: "fable"` when the session is on something else. Never ask the user to `/model`.
- When writing or editing any engineering doc under `docs/`, follow `docs/guides/eng-doc-style.md`.
- Write straight up — in prompts, docs, commits, code comments, summaries, and UI copy. State what a thing is, once, and stop. Never frame it against what it is not: no "X, not Y", no "X rather than Y", no "instead of Z", no "…, which is exactly what not to do". Cut filler.
- Keep replies short and action-oriented. For implementation questions, give the recommendation first, then one to three short bullets on why; when the answer is obvious, just say what to do. Skip long explanations, caveats, and "one last thing" sections; flag a real blocker or risk with "One issue:" and explain it briefly.
- Never dress a fact up as an aside. No "worth knowing", "worth flagging", "worth calling out", "one thing to note", "for future reference", "the part that matters here" — and no other phrase that announces information as bonus insight. This holds anywhere in a reply, not just at the end. If it matters, state it plainly as part of the work; if it does not, cut it. A problem gets fixed in the same turn it is found, and anything that changes what the user does belongs in the body of the summary, said once.
- Never ship a known gap. Finding a case that does not work — another type, another surface, another shelf — means fixing it in the same turn, before the summary. A line explaining what still fails is the work left undone; do the work. Ask only when closing it is a scope fork or a destructive action.
- Make the decision and do it. Implement the obvious next step; never end with "if you want, I can…" or ask the user to say the word. Save questions for genuine scope forks and destructive actions.
- Update guides in `docs/guides/` only for major features or durable supported-behavior changes. Do not update guide docs for small styling tweaks, layout adjustments, copy changes, or implementation-only refactors.
- Keep guides explanatory. They should teach what the system is, how it works, and which boundaries matter; do not turn guides into feature inventories, implementation logs, duplicated code, or long file lists.
- Optimize guides for readability: use plain language, short sections, and only the detail a maintainer needs to understand the supported boundary. Prefer trimming outdated or repetitive detail over adding more paragraphs.
- Keep guide source entrypoints short and readable. Do not write exhaustive file inventories. Prefer a small maintainer map by subsystem or one to seven high-signal paths, and link to a source path only when it gives someone a clear place to start.
- When asked to commit, group the working changes into logical commits by concern rather than one catch-all commit, then merge into `main`. Write messages as `type(scope): summary`, where `type` is a Conventional Commits kind (`feat`, `fix`, `docs`, `refactor`, `chore`, etc.) and `scope` is the area touched (e.g. `feat(site)`, `fix(app)`, `refactor(site)`); `scope` may be omitted when an area does not apply, as in `docs:`. Do not push unless asked.
- End the commit subject with ` [rebuild]` when the change ships inside the Mac app and needs a new build: `apps/`, the Cut engine (`site/src/cut/engine/`, `site/src/cut/server/`, and the `site/src/cut/lib/` modules they compile in — `types`, `ports`, `hosts`, `looks`, `colorGrade`, `cueAlign`, `backend/`), or bundled tooling (`tools/`, the bundled-tools scripts). The label is what triggers a release, so an app change without it never reaches users; hosted-site-only changes take no label.
- After a commit run finishes, ship iOS: when the committed changes touch `apps/ios/` and the working tree is clean, run `scripts/ship-ios-testflight.sh` once the merge into `main` lands, so the build reaches TestFlight. The script archives from the committed ref, so it goes after the commits.
- Prefer deleting over documenting what was removed. Guides describe what is supported now, not what used to be.
- Build forward by default. Prefer updating callers and contracts to the new supported shape instead of preserving old compatibility paths; ask before adding or keeping backwards-compatibility shims.
- Configuration is code with a runtime override. Tunables, switches and thresholds are declared in the settings registry (`site/src/lib/config/registry.ts`) with a default and a schema, overridden from su, and read through it everywhere; env is for secrets. An experiment is variants over settings, drawn by an audience; a feature that people might tune ships its setting in the same change.
- Fail hard. One provider, one model, one code path per job; a missing API key, service, or capability is an error surfaced to the caller. No secondary providers, no retry-on-another-model paths, no `env.X || default` softening. A fallback exists only when it is absolutely necessary — a surface that genuinely cannot carry the feature — and the summary and the guide say so.
- After finishing a task, summarize what you did. Ground the summary in the actual code changes — name the files and behavior that changed, not the intent you set out with. If nothing changed, say so. When the change has a shape worth seeing — a system flow or a UI layout — include a small ASCII diagram of it.
- This is an open source project. Stay alert for security concerns, and never commit PII, API keys, tokens, credentials, private config, or other secrets.
- Keep this file stable and lightweight.
