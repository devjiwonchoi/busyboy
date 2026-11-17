# AGENTS.md

Rules for every agent and contributor working in this repository.

| Rule                                                                                                                                                                                                                                                                                 | Enforced by                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| File and folder names are kebab-case, for example `server-process.ts`. Keep a tool-fixed name (`page.tsx`, `layout.tsx`, `route.ts`, `default.tsx`, `next.config.ts`, `README.md`, `AGENTS.md`) or a record file (`ALIGN.md`, `STATUS.md`, `VERIFY.md`, `REVIEW.md`, `REMEMBER.md`). | `scripts/check-agent-rules.mts` rejects an added path that is not kebab-case                    |
| Do not add a comment line in a `.ts`, `.tsx`, or `.mts` file. `// @ts-expect-error`, `/// <reference`, an eslint or oxlint disable line, and a shebang are allowed.                                                                                                                  | `scripts/check-new-comments.mts`                                                                |
| Do not edit `README.md`.                                                                                                                                                                                                                                                             | `scripts/check-agent-rules.mts`                                                                 |
| Do not add a Markdown document outside `tests/` or `.agents/skills/`. A skill and its feature map belong under `.agents/skills/`.                                                                                                                                                    | `scripts/check-agent-rules.mts`                                                                 |
| A change a person can see or operate is proven with verify-busyboy before the pull request opens: follow `.agents/skills/verify-busyboy/SKILL.md`, drive the feature, and attach the screenshot.                                                                                     | The `verify-busyboy` skill. Evidence goes in `.verify/evidence`, which git ignores.             |
| A new test file is a Playwright journey under `tests/` ending in `.spec.ts`.                                                                                                                                                                                                         | `scripts/check-agent-rules.mts`                                                                 |
| Do not add `test.skip`, `it.skip`, `describe.skip`, `test.fixme`, `it.fixme`, `describe.fixme`, `waitForTimeout`, `sleep`, or `retries` other than `retries: 0`.                                                                                                                     | `scripts/check-agent-rules.mts` fails when a test diff adds more of these than it removes       |
| Do not add `/opt/cursor/artifacts` in a test.                                                                                                                                                                                                                                        | `scripts/check-agent-rules.mts` fails when a test diff adds more of these paths than it removes |
| When a screenshot baseline under `*-snapshots/` changes, say so in the pull request description.                                                                                                                                                                                     | `scripts/check-agent-rules.mts`                                                                 |
| `pnpm typecheck` passes.                                                                                                                                                                                                                                                             | CI job Type check                                                                               |
| `pnpm lint` and `pnpm format:check` pass.                                                                                                                                                                                                                                            | CI job Lint                                                                                     |
| Playwright journeys pass.                                                                                                                                                                                                                                                            | CI job Journeys                                                                                 |

## Write everything in English

All text committed to this repository is English: code, identifiers, UI copy, error and log messages, test names, commit messages, and pull request descriptions.

## Build UI from the component library

The UI library is shadcn on Base UI (`base-mira` style, see `components.json`) with the `@coss` and `@spell` registries.

- Use a component from, in order: the shadcn base components, then `@coss`, then `@spell`. Add one with `pnpm shadcn add <name>`, `pnpm shadcn add @coss/<name>`, or `pnpm shadcn add @spell/<name>`.
- Edit an added component only when needed, and say why in the commit message.
- Write a custom component only when none of them supports the need, and say why in the commit message.

## Journeys

- Replace real providers with scripted replays. Use real files and git in temporary directories.
- Run only the tests you added or changed.

## Prove UI changes with verify-busyboy

A change to what a person sees or operates in BusyBoy is proven with the `verify-busyboy` skill before the pull request opens. Follow `.agents/skills/verify-busyboy/SKILL.md`: launch, run doctor, drive the feature that changed, and capture a screenshot of that path. Attach the screenshot to the pull request. Evidence is written to `.verify/evidence`, which git ignores, and cleanup leaves that folder in place.

## Check the risky logic

Two checks in the Model CI job cover logic a journey cannot exhaust. `scripts/check-task-lifecycle.mts` enumerates the task lifecycle: an archived task never shows a plan card, a waiting draft never runs work, auto-archive never archives an open pull request or a running turn, and a done card survives an archive stop. `scripts/check-always-ask.mts` generates always-ask commands: deletes outside the worktree and the record folder, force pushes, and unresolved publishes always ask; ordinary commands inside the worktree, the record folder, and `.busyboy-scratch` never ask; shell assignments are resolved before matching.

## Start from nothing

This branch starts from an empty history. Do not copy code from the `legacy` tag. Reading it for reference (`git show legacy:<path>`) is fine.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
