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
    "dist/**",
    "public/mediapipe/**",
    "next-env.d.ts",
    "src/clients/chatgpt/widget.generated.ts",
    "public/clients/chatgpt/**",
    // Cloudflare Worker shell for the Cut render worker: compiled by wrangler
    // against workers types, excluded from the site's tsconfig.
    "src/cut/worker/cf/**",
  ]),
  {
    // Every word the UI shows comes from the catalogs (src/i18n/messages), so
    // it reads in the visitor's language. JSX text and the attributes a person
    // reads or hears must not be literals; symbols and punctuation may be.
    files: [
      "src/app/**/*.tsx",
      "src/components/**/*.tsx",
      "src/cut/components/**/*.tsx",
      "src/clients/chatgpt/ui/**/*.tsx",
    ],
    // Super-user surfaces stay English.
    ignores: ["**/*.test.tsx", "src/app/legal/**", "**/SuperUserSection.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        {
          noStrings: false,
          ignoreProps: true,
          allowedStrings: [".", "·", "—", "–", "-", "×", "/", "|", "…", "%", ":", "+", "•", "→", "←", "↗", "(", ")", "x", "#", "@", "&", "s", "%)", "×)", "$", "°", "✕", "∿", "A", "Aa", "Donkey", "Donkey Cut", "Pro", "Reels", "Shorts", "Lottie", "Fable 5.1"],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name=/^(aria-label|aria-description|placeholder|title|alt)$/] > Literal[value=/[A-Za-z]/]:not([value=/^Donkey( Cut)?$/])",
          message: "Read this from the catalog (useTranslations / getTranslations).",
        },
      ],
    },
  },
  {
    // The session a component renders comes through the hook that keeps the
    // first client render equal to the server's HTML (lib/auth-client.ts).
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/auth-client.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "authClient", property: "useSession", message: "Use useSession from @/lib/auth-client; it renders the server's state until hydration." },
      ],
    },
  },
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
            {
              name: "@/lib/inference/typesafe-models",
              message: "The judge route pins the model; post to /api/inference/judge.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
