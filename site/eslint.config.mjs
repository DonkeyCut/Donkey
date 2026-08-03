import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare Worker shell for the Cut render worker: compiled by wrangler
    // against workers types, excluded from the site's tsconfig.
    "src/cut/worker/cf/**",
  ]),
  {
    // effects-kit is a standalone package: it must build for any host, so it
    // never reaches into the app's source or aliases.
    files: ["packages/effects-kit/**/*.ts", "packages/effects-kit/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*", "**/src/cut/*", "next", "next/*"],
              message: "effects-kit is host-agnostic — no site/src or Next.js imports.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
