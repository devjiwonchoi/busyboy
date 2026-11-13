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
