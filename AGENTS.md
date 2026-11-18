# AGENTS.md

Rules for every agent and contributor working in this repository.

| Rule                                                                                                                                                                                                                                                                            | Enforced by                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| File and folder names are kebab-case, for example `server-process.ts`. Keep a tool-fixed name (`page.tsx`, `layout.tsx`, `route.ts`, `default.tsx`, `next.config.ts`, `README.md`, `AGENTS.md`).                                                                                | `scripts/check-agent-rules.mts` rejects an added path that is not kebab-case                                          |
| Do not call `useEffect` from `apps/web/`. Compute the value during render, handle the event, reset with a `key`, or subscribe with `useSyncExternalStore`. External setup goes in a ref callback that returns its cleanup.                                                      | `scripts/check-no-use-effect.mts`                                                                                     |
| Comments are banned (pstack no-comments). Keep a license header, a formatter or lint directive, or a comment that links the issue or vendor doc for a constraint from Electron, the OS, Next.js, or a harness CLI. Delete any other comment and make the code self-explanatory. | `scripts/check-comments.mts`, `scripts/check-new-comments.mts`, oxlint `no-warning-comments` and `no-inline-comments` |
| Do not edit `README.md`.                                                                                                                                                                                                                                                        | `scripts/check-agent-rules.mts`                                                                                       |
| `apps/web/components/ui` is the shadcn registry output. Do not edit those files by hand.                                                                                                                                                                                        | `scripts/check-agent-rules.mts` regenerates each file with the pinned shadcn CLI and diffs it                         |
| `apps/web/app/globals.css` is the shadcn init output for `apps/web/components.json`. Do not edit it by hand.                                                                                                                                                                    | `scripts/check-agent-rules.mts` regenerates it with the pinned shadcn CLI and diffs it                                |
| Outside `apps/web/components/ui`, do not use Tailwind arbitrary values or raw palette color classes. Use a token class or a shadcn component variant.                                                                                                                           | `scripts/check-agent-rules.mts`                                                                                       |
| Route segment files (`page`, `layout`, `template`, `default`, `loading`, `not-found`, `forbidden`, `unauthorized`) are Server Components; put `"use client"` in a component they import.                                                                                        | oxlint `busyboy/no-use-client-segment`                                                                                |
| `pnpm typecheck` passes.                                                                                                                                                                                                                                                        | CI job Type check                                                                                                     |
| `pnpm lint` (oxlint with the `eslint-config-next` rules, then knip) and `pnpm format:check` pass. Unused code, exports, files, and dependencies are errors. Every rule is `error`; none is `warn`.                                                                              | CI job Lint                                                                                                           |

## Write everything in English

All text committed to this repository is English: code, identifiers, UI copy, error and log messages, test names, commit messages, and pull request descriptions.

## Build UI from the component library

The UI library is shadcn on Base UI (`base-mira` style, see `apps/web/components.json`) with the `@coss` and `@spell` registries.

- Use a component from, in order: the shadcn base components, then `@coss`, then `@spell`. Add one with `pnpm exec shadcn add <name>` from `apps/web`.
- Do not edit `apps/web/components/ui` or `apps/web/app/globals.css` by hand. Regenerate them with the pinned shadcn CLI.
- Write a custom component only when none of them supports the need, and say why in the commit message. Use token classes, not arbitrary values or raw palette colors.

## Start from nothing

This branch starts from an empty history. Do not copy code from the `legacy` tag. Reading it for reference (`git show legacy:<path>`) is fine.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
