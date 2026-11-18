# AGENTS.md

Rules for every agent and contributor working in this repository.

- File and folder names are kebab-case, for example `server-process.ts`. Keep a tool-fixed name (`page.tsx`, `layout.tsx`, `route.ts`, `default.tsx`, `next.config.ts`, `README.md`, `AGENTS.md`, `DOMAIN.md`).
- Do not edit `README.md`.
- Do not add a Markdown document except `DOMAIN.md`.
- Update `DOMAIN.md` in the same pull request when a flow or code path it names changes.
- `apps/web/components/ui` is the shadcn registry output. Do not edit those files by hand.
- `apps/web/app/globals.css` is the shadcn init output for `apps/web/components.json`. Do not edit it by hand.
- Outside `apps/web/components/ui`, do not use Tailwind arbitrary values or raw palette color classes. Use a token class or a shadcn component variant.
- `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` pass. Lint is oxlint with the rules of `eslint-config-next` (`core-web-vitals` and `typescript`).

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
