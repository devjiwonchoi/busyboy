# BusyBoy verification map

This directory is the source for verifying what a person can do in BusyBoy. Read this index, then follow the feature file. The product is harness sign-in, then one Director chat. The harness is the real CLI. There is no scripted replay.

## Baseline preconditions

- Run `pnpm drive launch` so BusyBoy is usable on the Next surface with a new `busyboy-verify-*` data directory.
- Run `pnpm drive doctor` and require exit code 0, `surface: next`, and `transcript: connected`.
- Drive only the instance this launch started.

## Features

- [Director chat send](./director-chat-send.md) sends a message and checks that the transcript file stored it.
- [First run](./first-run.md) signs in to an agent and opens the chat.
