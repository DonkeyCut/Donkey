import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  pageExtensions: ["js", "jsx", "ts", "tsx", "md", "mdx"],
  // Workspace packages ship TypeScript source; the app build transpiles them.
  transpilePackages: ["@donkeycut/effects-kit", "@donkeycut/abexp", "@donkeycut/artifact-player"],
  // Cache Components: pages prerender to a static shell and anything uncached
  // streams behind its own Suspense boundary. It is what the `instant`
  // export on the public pages and the app's home routes validates against, and
  // it puts the router's client cache on React <Activity> — a page you navigate
  // away from stays mounted hidden (up to three), with its effects torn down.
  // The editor is built for that already: it paints its loading screen until
  // the store holds this route's own project, and usePlayback disposes decoders
  // and the audio mixer from an effect cleanup.
  cacheComponents: true,
  // One App Shell per route is prefetched and shared by every link to it,
  // and a route visited at an address the build did not list (a blog post
  // published after the deploy) is rendered in the background on that first
  // visit and served fully static from then on.
  partialPrefetching: true,
  // Keep the server origin intact when the proxy rewrites a local request.
  // Normalizing 127.0.0.1 to localhost makes Next treat it as an external hop.
  skipProxyUrlNormalize: true,
  // Cut (the video editor) uploads large media. Two independent limits apply:
  // its media route reads req.formData() (a route handler), so it isn't covered
  // by serverActions.bodySizeLimit; and src/proxy.ts runs on /api/cut/* on every
  // request, which makes Next clone the request body and truncate it at the 10MB
  // proxy default — a truncated multipart body then fails formData parsing. Raise
  // both so real video/audio files upload intact.
  experimental: {
    serverActions: { bodySizeLimit: "4gb" },
    proxyClientMaxBodySize: "4gb",
  },
  // Build assets are fetched by search crawlers to render pages, which puts
  // every chunk, stylesheet and font in Search Console as a candidate page.
  // The header lets them be fetched and keeps them out of the index.
  // ChatGPT links the card's title to the widget domain; that lands in the app.
  redirects: async () => [
    {
      source: "/:path*",
      has: [{ type: "host", value: "chatgpt.donkeycut.com" }],
      destination: "https://donkeycut.com/app",
      permanent: false,
    },
  ],
  headers: async () => [
    {
      source: "/clients/chatgpt/:path*",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
    {
      // ChatGPT caches the widget HTML, so the entry it names revalidates
      // on every load while the hashed chunks stay immutable.
      source: "/clients/chatgpt/main.:ext(js|css)",
      headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
    },
    {
      source: "/_next/static/:path*",
      headers: [{ key: "X-Robots-Tag", value: "noindex" }],
    },
  ],
  // Cut is local-only: /api/cut/* 404s on a hosted deploy and never runs the
  // engine. But Turbopack's file tracer still follows the route's import of the
  // engine router, and that graph reaches cwd-rooted file operations it can't
  // statically scope — so it sweeps local media, committed stock video, and the
  // ~220MB Claude Agent SDK CLI binary into the serverless function, past
  // Vercel's 250MB limit. (outputFileTracingExcludes can't help: it's a no-op
  // under Turbopack builds.) On hosted builds only, alias the engine entry to a
  // 404 stub so the engine graph is never traced; local builds keep the real
  // router, so `next dev`/`next start` serve Cut normally.
  turbopack: process.env.VERCEL
    ? {
        resolveAlias: {
          "@/cut/server/http/next": "./src/cut/server/http/hosted-stub.ts",
        },
      }
    : undefined,
};

const withMDX = createMDX({
  extension: /\.(md|mdx)$/,
});

export default withMDX(nextConfig);
