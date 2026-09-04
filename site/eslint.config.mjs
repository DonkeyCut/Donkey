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
    // The packages are standalone: each must build for any host, so none
    // reaches into the app's source or aliases.
    files: ["packages/*/**/*.ts", "packages/*/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*", "**/src/cut/*", "next", "next/*"],
              message: "Packages are host-agnostic — no site/src or Next.js imports.",
            },
          ],
        },
      ],
    },
  },
  {
    // The page, the chat loop and the turn worker ship separately from the
    // site's routes, so a model id baked into them outlives a registry bump.
    // They name a role and the responses route resolves it.
    files: ["src/cut/lib/**/*.ts", "src/cut/lib/**/*.tsx", "src/cut/components/**/*.tsx", "src/cut/components/**/*.ts", "src/cut/hooks/**/*.ts", "src/cut/worker/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/inference/gemini-models",
              importNames: [
                "geminiModels",
                "geminiModelRoles",
                "geminiTtsModels",
                "geminiOmniModels",
                "geminiTranscribeModels",
                "geminiMusicModels",
              ],
              message: "Name a model role (geminiModelRoleNames); the responses route resolves the id.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
