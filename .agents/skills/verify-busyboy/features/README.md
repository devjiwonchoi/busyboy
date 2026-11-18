# BusyBoy verification map

This directory is the source for verifying what a person can do in BusyBoy. Read this index, then follow the feature file. The product is harness sign-in, then one Director chat.

## Baseline preconditions

- Run `pnpm drive launch` so BusyBoy is usable on the Next surface with a new `busyboy-verify-*` data directory.
- Run `pnpm drive doctor` and require exit code 0, `surface: next`, `transcript: connected`, and `scripted providers: active`.
- Drive only the instance this launch started.

## Features

- [Director chat send](./director-chat-send.md) sends a question and checks the reply in the transcript file.
- [First run](./first-run.md) signs in to an agent and opens the chat.
