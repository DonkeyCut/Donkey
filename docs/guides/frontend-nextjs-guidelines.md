# Frontend and Next.js Guidelines

How to work in the `site` Next.js app: route structure, server/client
boundaries, Tailwind styling, and data access.

**The one rule:** React components never call `fetch(...)` directly.
Client-side data access goes through TanStack Query hooks in `src/queries/`;
server-side data access stays in server code. If you're tempted to fetch
inline, the call belongs in a hook.

## Project Shape

- Routes, layouts, pages, loading states, and route handlers live in
  `src/app`.
- Shared UI primitives live in `src/components`; route-specific UI stays near
  the route, such as `src/app/_components/landing` for the home page.
- Server-only helpers live in `src/lib`.
- Split large route experiences into focused component files.
- Use absolute imports through the `@/*` alias; avoid barrel `index.ts` files
  unless a package-level public API truly needs one.

## Components

- Components are Server Components by default. Add `"use client"` only for
  state, effects, refs, event handlers, browser APIs, or client-only hooks.
- Keep client boundaries small and close to the interactive control.
- Keep secrets and direct database access out of Client Components.
- Pass plain serializable props from Server Components into Client Components.

## Rendering

Cache Components is on. A page prerenders to a static shell, and anything that
reads request data — `cookies()`, `headers()`, `params`, `searchParams` — or
fetches uncached has to sit behind its own `<Suspense>` boundary and streams in
after the shell. Data that rarely changes goes behind `use cache`, as close to
the read as you can put it.

The old route segment configs are gone with it. `dynamic`, `revalidate`,
`fetchCache`, and `runtime` fail the build; a handler that must run per request
awaits `connection()` from `next/server`, and a cache duration is `cacheLife`
inside a `use cache` scope.

A page that should feel instant declares it:

```ts
export const unstable_instant = { prefetch: "static" };
```

Next then checks, in dev and at build, that the route produces a shell at every
entry point, and names the component that would block the navigation. The public
pages carry it, and so do the app's home surfaces.

Getting the app there set the boundary the whole subtree is built around. The
chrome — the surface, the sidebar, the connect banner — renders with no session
and no account, and is what a cold load paints. Everything that reads the engine
waits behind `SessionGate` for the account id, because every engine URL carries
it. A new surface picks a side: chrome, or behind the gate with a skeleton.

Two things keep metadata out of the way of a static shell, and both are set in
the root layout: `metadataBase`, so a relative card URL resolves against the
canonical host, and `icons`, which declares the favicon and Apple icon. Dropping
those in `src/app` as files makes them file-based metadata, which resolves per
request and holds back the shell of every page in the app.

Navigating away no longer unmounts a page. Next keeps the last few routes
mounted in a hidden React `<Activity>`, so their DOM and state survive a trip
away and back. Effects are torn down on the way out and re-run on the way back,
so anything holding a real resource — a decoder, an audio graph, a timer —
releases it in an effect cleanup, and anything transient that should not come
back open, like a dropdown, closes in a `useLayoutEffect` cleanup.

## Navigation

- Use the `next/link` `<Link>` component for internal routes (anything
  starting with `/`) so navigation stays client-side and prefetches. Use a
  plain `<a>` only for external URLs, `mailto:`, and other non-route links.
- When a shared control accepts an arbitrary `href` (such as the landing
  `PillButton`), let the control pick `<Link>` vs `<a>` from the href instead
  of duplicating that choice at every call site.

## Styling

- Tailwind utility classes are the default for all UI, with no exceptions by
  area. Do not write React inline `style` objects for layout, spacing,
  typography, colors, borders, or responsive behavior. Reserve inline `style`
  strictly for genuinely runtime values: a dimension computed from props or
  state, CSS custom properties derived from data, or a third-party style API.
- Tailwind is configured via CSS (`@theme` in `src/app/globals.css`), not a
  `tailwind.config.*` file; its absence is not a reason to use inline styles.
- When a style genuinely exceeds utilities — a custom `@keyframes` animation, a
  layered `box-shadow` — put it in a plain `.css` file beside the feature and
  pull it into the bundle with a side-effect import (`import "./thing.css"`)
  from the module that owns the class. Reserve `globals.css` for base and theme
  styles; feature CSS lives with its feature. Apply the class through the normal
  `className`, composing with utilities via `cn`.
- Use the brand tokens defined in `globals.css` rather than repeating raw hex:
  `text-ink`/`bg-ink`/`border-ink` (near-black), `bg-coral`/`text-coral`,
  `bg-cream`, `bg-background` (page sand), and `font-system`/`font-code`.
  Reach for a Tailwind arbitrary value (`text-[#454545]`,
  `text-[clamp(45px,9.6vw,134px)]`) only for genuinely one-off values not
  worth a token.
- Use Tailwind responsive variants for breakpoints (`md:*`, and arbitrary
  variants like `min-[900px]:*` for a non-standard breakpoint). Do not add
  client-only media-query hooks to choose styling. When an element only
  differs by visibility, toggle it with `hidden`/`md:block` rather than
  conditional rendering.
- Compose conditional classes with the `cn` helper from `@/lib/utils`.
- Prefer existing icon components for buttons and compact actions when an icon
  fits the control.
- Keep controls at stable dimensions so hover states, icons, labels, and
  loading states do not shift layout.
- Keep cards for repeated items, modals, and genuinely framed content. Avoid
  nesting cards inside cards.

## Data and APIs

- Route Handlers live in `src/app/api/**/route.ts` and follow
  `docs/guides/backend-apis.md` — authenticated by default, Zod-validated,
  explicit responses.
- Every query/mutation hook lives in `src/queries/` so the cache surface is
  auditable in one place. Components import the hooks; they do not fetch
  inline. The shared fetch wrapper and error type are
  `src/queries/apiClient.ts`. Define each query's key as a constant alongside
  its hook in the same module (export it if another module needs to invalidate
  it). Mount `QueryProvider` once at the root layout.
- Per-user account views (`/app/settings`, including usage) are
  client-rendered and read their data through these hooks. The route handlers
  still enforce auth server-side, so a client guard is for UX, not security.
- Use database clients only from server-side code, and never run migrations or
  schema pushes casually; choose the migration workflow deliberately for the
  target database.

## TypeScript

- Use `type` for props and local data shapes; prefer a short `Props` name when
  there is only one props type in the file.
- Do not use `any`; define the narrowest useful type or stop and clarify.
- Prefer optional chaining (`a?.b`) over `a && a.b` or `!a || !a.b` when
  reading a possibly-absent member.
- Keep imports direct and explicit.
- Include real dependencies in hooks; store callbacks in refs when they should
  not trigger re-renders.

## Checks

- Do not commit `.env` or secrets.
- Run `npm run lint` and `npm run build` before shipping frontend changes.
