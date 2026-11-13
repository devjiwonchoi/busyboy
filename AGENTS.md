# AGENTS.md

Rules for every agent and contributor working in this repository.

## Write everything in English

All text committed to this repository is English: code, identifiers, comments, UI copy, error and log messages, test names, commit messages, and PR descriptions.

## Never commit documents

Do not add research notes, reports, specs, plans, or other documents to the repository, and do not open PRs whose purpose is a document. Deliver them in the conversation instead. Code comments, PR descriptions, and README changes that a code change needs are fine.

## Use kebab-case file names

Every file and folder name is kebab-case, for example `server-process.ts` or `bottom-panel.tsx`. Files whose names are fixed by a tool (`AGENTS.md`, `README.md`, `page.tsx`, `next.config.ts`) keep those names.

## Test with end-to-end journeys only

- Do not write unit tests.
- Tests are deterministic Playwright journeys under `tests/`, named by action and outcome, for example `clicking Approve should start the task`.
- Replace real providers with scripted replays; use real files and git in temporary directories.
- Run only the tests you added or changed.

## Start from nothing

This branch starts from an empty history. Do not copy code from the `legacy` tag. Reading it for reference (`git show legacy:<path>`) is fine.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
