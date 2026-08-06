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
    // Local Claude Code state — notably .claude/worktrees/* holds checkouts of
    // OTHER branches whose (older) source would otherwise be linted and inflate
    // the warning count vs CI (which never has this dir). Gitignored.
    ".claude/**",
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
      // Kept at `warn` (not `error`). The rule (eslint-plugin-react-hooks v6+ /
      // Next.js 16) flags EVERY setState reachable from a useEffect — including
      // the idiomatic data-fetch-on-mount pattern where setState only runs
      // after an await. Issue #442 drove the count from 109 down to a small
      // honest budget via genuine refactors: the `useLoad` hook for data
      // loaders, `onEnter`/key-remount for reset-on-open modals, and moving
      // bulk-selection clears into the search/tab handlers. The residual is the
      // rule's documented false-positive / legitimate-effect class — prop
      // mirrors, guards, localStorage reads, timers, derived-from-loaded-data —
      // deliberately LEFT as warnings under the ratcheting `--max-warnings` cap
      // (package.json) rather than mass-suppressed with inline-disables. New
      // instances still surface in review; the cap only ratchets down.
      "react-hooks/set-state-in-effect": "warn",
      // NOTE: a `no-restricted-imports` ratchet used to live here, forbidding the
      // untyped `getSupabase` getter, alongside a grandfather block exempting the
      // not-yet-migrated paths (issue #573). Both are gone: `lib/supabase.ts` now
      // exports a single, always-typed getter, so there is no untyped symbol left
      // to import and nothing for a lint rule to guard. Don't reintroduce either —
      // the guarantee is structural now, not an exemption list someone maintains.
    },
  },
]);

export default eslintConfig;
