# Domain map

BusyBoy is harness login, then one Director chat. The signed-in CLI (Claude Code, Codex, or Grok) writes the reply. BusyBoy stores the transcript and streams that text. Stop interrupts the running turn.

Read this file before tracing a flow through the code. Update it in the same pull request when a flow or a code path named here changes.

## Information architecture

```mermaid
flowchart TD
  Launch["Launch"] --> SignedIn{"Harness logged in?"}
  SignedIn -->|no| Setup["Setup"]
  SignedIn -->|yes| Chat["Chat"]
  Setup --> Chat
  Chat --> Send["Send"]
  Send --> Stream["Stream"]
  Stream --> Chat
  Stop["Stop"] -.->|interrupts| Stream
```

Launch is `apps/web/proxy.ts` `proxy`. "Harness logged in?" is `apps/web/server/config.ts` `isSetupComplete`: `setupCompletedAt` is set only after Continue on a signed-in harness.

## Setup

The only setup step is signing in to a harness the person already has. BusyBoy does not sign in for them.

```mermaid
flowchart TD
  Request["apps/web/proxy.ts proxy"] --> Redirect["apps/web/proxy.ts setupRedirect"]
  Redirect --> Settings["apps/web/server/config.ts readSettingsAt"]
  Settings --> Complete{"apps/web/server/config.ts isSetupComplete"}
  Complete -->|no| Page["apps/web/app/setup/page.tsx HarnessStep"]
  Complete -->|yes| Home["apps/web/app/page.tsx Chat"]
  Page --> State["apps/web/server/providers.ts providerState"]
  State --> SignIn["apps/web/server/runner/agent-runner.ts providerSignInStatus"]
  SignIn --> Claude["apps/web/server/runner/claude-adapter.ts claudeSignInStatus"]
  SignIn --> Codex["apps/web/server/runner/codex-adapter.ts codexSignInStatus"]
  SignIn --> Grok["apps/web/server/runner/grok-adapter.ts grokSignInStatus"]
  Page --> Copy["apps/web/components/setup/copy-command.tsx CopyCommand"]
  Page --> Recheck["apps/web/app/setup/actions.ts recheckProvidersAction"]
  Recheck --> State
  Page --> Finish["apps/web/app/setup/actions.ts finishSetupAction"]
  Finish --> Choose["apps/web/server/providers.ts setDefaultProvider"]
  Finish --> Stamp["apps/web/server/config.ts updateSettings"]
  Stamp --> Home
```

Code paths:

- `apps/web/proxy.ts` `proxy`, `isAllowedHost`, `setupRedirect`
- `apps/web/server/config.ts` `resolveDataFolder`, `readSettingsAt`, `readSettings`, `isSetupComplete`, `updateSettings`
- `apps/web/app/setup/page.tsx` `HarnessStep`, `BackToChat`
- `apps/web/server/providers.ts` `providerState`, `signedInProviders`, `defaultProvider`, `setDefaultProvider`
- `apps/web/server/runner/agent-runner.ts` `providerSignInStatus`, `adapterFor`
- `apps/web/server/runner/claude-adapter.ts` `claudeSignInStatus`, `resolveClaude`
- `apps/web/server/runner/codex-adapter.ts` `codexSignInStatus`, `accountStatus`, `resolveCodex`
- `apps/web/server/runner/grok-adapter.ts` `grokSignInStatus`, `resolveGrok`
- `apps/web/server/runner/find-executable.ts` `findExecutable`
- `apps/web/components/setup/copy-command.tsx` `CopyCommand`
- `apps/web/app/setup/actions.ts` `recheckProvidersAction`, `finishSetupAction`

## Chat

After setup, one screen holds the transcript and the composer.

```mermaid
flowchart TD
  Page["apps/web/app/page.tsx Chat"] --> View["apps/web/components/chat/director-chat.tsx DirectorChat"]
  View --> Events["GET apps/web/app/api/director/events/route.ts GET"]
  Events --> Folder["apps/web/server/config.ts dataFolder"]
  Folder --> Sub["apps/web/server/director/chat.ts subscribeToDirector"]
  Sub --> Load["apps/web/server/director/chat.ts load"]
  Load --> Read["apps/web/server/director/transcript-log.ts readTranscript"]
  Sub --> Reset["DirectorUpdate reset"]
  Reset --> Apply["apps/web/components/chat/director-chat.tsx apply"]
```

Code paths:

- `apps/web/app/page.tsx` `Chat`
- `apps/web/components/chat/director-chat.tsx` `DirectorChat`, `apply`, `MessageView`
- `apps/web/hooks/use-external-sync.ts` `useExternalSync`
- `apps/web/app/api/director/events/route.ts` `GET`
- `apps/web/server/config.ts` `dataFolder`
- `apps/web/server/director/chat.ts` `subscribeToDirector`, `getDirector`, `load`
- `apps/web/server/director/transcript-log.ts` `readTranscript`

## Send and Stream

Send stores the person's text, starts or resumes the signed-in harness in the home directory, and hands it the message. Stream is the harness text as it arrives. The turn then returns to Chat.

```mermaid
flowchart TD
  Composer["apps/web/components/chat/director-chat.tsx DirectorChat send"] --> Action["apps/web/app/director-actions.ts sendToDirectorAction"]
  Action --> Send["apps/web/server/director/chat.ts sendToDirector"]
  Send --> SaveUser["apps/web/server/director/chat.ts saveEntry"]
  SaveUser --> Append["apps/web/server/director/transcript-log.ts appendTranscriptLine"]
  Send --> Ensure["apps/web/server/director/chat.ts ensureAgent"]
  Ensure --> Default["apps/web/server/providers.ts defaultProvider"]
  Ensure --> Start["apps/web/server/runner/agent-runner.ts startAgent"]
  Start --> Launch["apps/web/server/runner/agent-runner.ts launch"]
  Launch --> Pick["apps/web/server/runner/agent-runner.ts adapterFor"]
  Pick --> Claude["apps/web/server/runner/claude-adapter.ts startClaude"]
  Pick --> Codex["apps/web/server/runner/codex-adapter.ts startCodex"]
  Pick --> Grok["apps/web/server/runner/grok-adapter.ts startGrok"]
  Send --> Message["apps/web/server/runner/agent-runner.ts sendMessage"]
  Claude --> MapC["apps/web/server/runner/claude-events.ts ClaudeEventMapper.push"]
  Codex --> MapX["apps/web/server/runner/codex-events.ts CodexEventMapper.push"]
  Grok --> MapG["apps/web/server/runner/grok-events.ts GrokEventMapper.pushUpdate"]
  MapC --> Record["apps/web/server/runner/agent-runner.ts record"]
  MapX --> Record
  MapG --> Record
  Record --> Listen["apps/web/server/runner/agent-runner.ts subscribeToAgent"]
  Listen --> OnEvent["apps/web/server/director/chat.ts onAgentEvent"]
  OnEvent --> Draft["apps/web/server/director/chat.ts publishDraft"]
  OnEvent --> SaveReply["apps/web/server/director/chat.ts saveEntry"]
  Draft --> Sse["apps/web/app/api/director/events/route.ts GET"]
  SaveReply --> Sse
  Sse --> Apply["apps/web/components/chat/director-chat.tsx apply"]
```

`startClaude` turns text into a Claude user message with `apps/web/server/runner/user-turn.ts` `claudeContent` and `modelText`. `startCodex` uses `codexInput` and `modelText`. `startGrok` uses `modelText`. `apps/web/server/runner/find-executable.ts` `findExecutable` and `agentEnvironment` locate the CLI and build its environment. `apps/web/server/director/context.ts` `DIRECTOR_INSTRUCTIONS` is the system prompt passed to `startAgent`.

Permission calls the harness still sends to the host are accepted inside the adapter (`startClaude` `canUseTool`, `startCodex` approval replies, `startGrok` `decide`) so BusyBoy does not show an approval card. The launch mode is the harness auto mode: `startClaude` uses `auto`, `apps/web/server/runner/codex-adapter.ts` `codexThreadSettings` uses `auto_review`, and `apps/web/server/runner/grok-adapter.ts` `grokPermissionMode` uses `auto`.

Code paths:

- `apps/web/components/chat/director-chat.tsx` `DirectorChat`
- `apps/web/app/director-actions.ts` `sendToDirectorAction`
- `apps/web/server/director/chat.ts` `sendToDirector`, `ensureAgent`, `onAgentEvent`, `saveEntry`, `publishDraft`, `saveState`
- `apps/web/server/director/transcript-log.ts` `appendTranscriptLine`
- `apps/web/server/director/context.ts` `DIRECTOR_INSTRUCTIONS`
- `apps/web/server/providers.ts` `defaultProvider`
- `apps/web/server/runner/agent-runner.ts` `startAgent`, `launch`, `adapterFor`, `sendMessage`, `subscribeToAgent`, `record`
- `apps/web/server/runner/user-turn.ts` `asTurn`, `modelText`, `claudeContent`, `codexInput`
- `apps/web/server/runner/claude-adapter.ts` `startClaude`
- `apps/web/server/runner/claude-events.ts` `ClaudeEventMapper`
- `apps/web/server/runner/claude-process.ts` `spawnClaudeProcess`
- `apps/web/server/runner/codex-adapter.ts` `startCodex`, `codexThreadSettings`
- `apps/web/server/runner/codex-events.ts` `CodexEventMapper`
- `apps/web/server/runner/grok-adapter.ts` `startGrok`, `grokPermissionMode`
- `apps/web/server/runner/grok-events.ts` `GrokEventMapper`
- `apps/web/server/runner/find-executable.ts` `findExecutable`, `agentEnvironment`
- `apps/web/app/api/director/events/route.ts` `GET`

## Stop

Stop interrupts the harness turn. The partial reply, if any, is stored and the chat returns to idle.

```mermaid
flowchart TD
  Button["apps/web/components/chat/director-chat.tsx DirectorChat Stop"] --> Action["apps/web/app/director-actions.ts stopDirectorAction"]
  Action --> Stop["apps/web/server/director/chat.ts stopDirector"]
  Stop --> Interrupt["apps/web/server/runner/agent-runner.ts interruptAgent"]
  Interrupt --> Claude["apps/web/server/runner/claude-adapter.ts startClaude interrupt"]
  Interrupt --> Codex["apps/web/server/runner/codex-adapter.ts startCodex interrupt"]
  Interrupt --> Grok["apps/web/server/runner/grok-adapter.ts startGrok interrupt"]
  Claude --> Done["apps/web/server/director/chat.ts onAgentEvent turn-done or stopped"]
  Codex --> Done
  Grok --> Done
  Done --> Save["apps/web/server/director/chat.ts saveEntry"]
  Save --> Idle["status idle"]
```

Code paths:

- `apps/web/components/chat/director-chat.tsx` `DirectorChat`
- `apps/web/app/director-actions.ts` `stopDirectorAction`
- `apps/web/server/director/chat.ts` `stopDirector`, `onAgentEvent`, `saveEntry`, `setStatus`
- `apps/web/server/runner/agent-runner.ts` `interruptAgent`
- `apps/web/server/runner/claude-adapter.ts` `startClaude`
- `apps/web/server/runner/codex-adapter.ts` `startCodex`
- `apps/web/server/runner/grok-adapter.ts` `startGrok`
