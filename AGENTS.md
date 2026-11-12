# AGENTS.md

Rules for every agent working in this repository: task leads, subagents, and the project manager.

## Never commit documents

Do not add research notes, reports, specs, plans, or other documents to the repository, and do not open PRs whose purpose is a document.
- Deliver research and reports in the thread: a message, an HTML visual, or a file outside the repo.
- If a task asks for a doc PR, deliver the content in the thread instead and say so.
- This covers `docs/` and similar paths. It does not cover code comments, PR descriptions, or README changes that a code change needs.

## Ship UI changes to web and mobile together

Every user-facing UI or behavior change goes into both `apps/web` and `apps/mobile` (the Expo app) in the same task.
- If a change applies to only one of them, say why in the PR body.
- Verify with screenshots of both the desktop web app and the mobile app. A phone-sized viewport of the web app does not count as mobile app verification.

## Write everything in the codebase in English

All text committed to this repository is English, whatever language the user writes in.
- This covers code, identifiers, comments, UI copy, error and log messages, test names and fixtures, docs and READMEs, and commit and PR messages.
- Conversation with the user stays in their language: chat replies, questions, cards, and task notes. Everything in the repository, its commits, and its PRs is English.
