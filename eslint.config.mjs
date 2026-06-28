import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

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
    // Generated test artifact (istanbul coverage report ships its own stale
    // eslint-disable directives). Gitignored; not present in CI at lint time,
    // but keeps local `pnpm lint` clean after a coverage run so the
    // --max-warnings 0 cap stays honest.
    "coverage/**",
  ]),
  {
    // ESLint 9 flat config: rules from a plugin need the plugin registered
    // in the same config block (or one with overlapping `files`). The
    // `eslint-config-next` "next" entry registers react-hooks under a
    // `files: [tsx/ts]` glob that this block widens to defaults; without
    // re-registering, ESLint can't resolve `react-hooks/...` here.
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Allow underscore-prefix to mark intentionally-unused parameters and
      // variables. Standard convention; matches typescript-eslint's defaults
      // for ignoring _-prefixed names.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Downgraded from `error` to `warn`. The rule (new in
      // eslint-plugin-react-hooks v6 / Next.js 16) statically flags every
      // setState call reached from inside a useEffect — including the
      // standard data-fetch-on-mount pattern where the setState only
      // happens after an await. ~78 of these in the codebase, almost all
      // false positives (the actual cascading-render anti-pattern is rare).
      // Keep as a warning so new instances are still surfaced in review,
      // but don't block CI on existing call sites. Refactor surfaces that
      // genuinely loop (where the rule is right) in the same PR that
      // touches the affected component.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
