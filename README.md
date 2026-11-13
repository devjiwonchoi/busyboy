# Busyboy

Busyboy is a desktop app for running coding tasks across several projects. You chat with one master agent, it delegates work to task agents driven by your installed Claude Code and Codex CLIs, and you follow progress in a node graph and action cards.

The previous app is kept under the `legacy` tag.

## Develop

```bash
pnpm install
pnpm dev                # Next dev server
pnpm dev:desktop        # Electron against the last `pnpm build`
pnpm build:desktop      # Package the desktop app into release/
pnpm test:e2e           # Playwright journeys
```

Run `release/mac-arm64/Busyboy.app/Contents/MacOS/Busyboy --self-check=<file>` to start the packaged app, load the page, write a JSON result, and exit.
