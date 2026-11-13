import type {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  type ActionCard,
  type ActionCardOption,
  PLAN_CHANGE_LABEL,
  projectMentionStatus,
  quoteForComposer,
  RESULT_APPROVE_LABEL,
  RESULT_FIX_LABEL,
  resultFixMessage,
  resultMergeRequestMessage,
} from "@t3tools/shared/one-chat";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useUpdateClientSettings } from "~/hooks/useSettings";
import { resolveShortcutCommand } from "~/keybindings";
import { useAnswerDecision } from "~/state/projectTeam";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { ActionCardModal } from "./action-card-modal";
import { OneChatComposer, type OneChatComposerHandle } from "./one-chat-composer";
import { useOneChatCommands } from "./one-chat-commands";
import { useOneChatData, useThreadView } from "./one-chat-data";
import { OneChatFeed } from "./one-chat-feed";
import { SideChat, type SideChatSource } from "./side-chat";
import { WorkToast } from "./work-toast";

const SIDE_CHAT_COMMAND = "oneChat.sideChat.toggle";

/** The server's keybindings, with the side chat default added if an older server lacks it. */
function useSideChatKeybindings() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (keybindings.some((binding) => binding.command === SIDE_CHAT_COMMAND)) return keybindings;
  return [
    ...keybindings,
    ...DEFAULT_RESOLVED_KEYBINDINGS.filter((binding) => binding.command === SIDE_CHAT_COMMAND),
  ];
}

interface DirectorThreadFields {
  readonly projectId?: string;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

/**
 * The one chat screen: the Director's chat with the action cards in it, the work toast, and
 * one composer. No sidebar and no right panel.
 */
export function OneChatScreen() {
  const navigate = useNavigate();
  const updateClientSettings = useUpdateClientSettings();
  const data = useOneChatData();
  const director = useThreadView(data.directorRef);
  const commands = useOneChatCommands();
  const answerDecision = useAnswerDecision();
  const keybindings = useSideChatKeybindings();
  const composerRef = useRef<OneChatComposerHandle>(null);
  const [detailsCardId, setDetailsCardId] = useState<string | null>(null);
  const [sideChatOpen, setSideChatOpen] = useState(false);
  // Cards the user just answered, shown collapsed until the server catches up. Result cards
  // have no server item, so they stay here.
  const [answeredLocally, setAnsweredLocally] = useState<ReadonlyMap<string, string>>(new Map());

  const cards = data.cards.map((card) => {
    const label = answeredLocally.get(card.id);
    return label !== undefined && card.answered === null
      ? { ...card, answered: { label, at: null } }
      : card;
  });
  const detailsCard = cards.find((card) => card.id === detailsCardId) ?? null;
  const mentions = projectMentionStatus(data.projects, data.graph, data.taskWorktrees);
  const titles = new Map<string, string>(
    data.projects.flatMap((project) => project.summary.tasks.map((task) => [task.id, task.title])),
  );
  for (const node of data.graph?.nodes ?? []) titles.set(node.id, node.contract?.title ?? node.id);
  const lookup = {
    titleOf: (id: string) => titles.get(id) ?? id,
    nodeOf: (nodeId: string) => data.graph?.nodes.find((node) => node.id === nodeId) ?? null,
  };

  const thread = director.thread as DirectorThreadFields | null;
  const runtimeMode: RuntimeMode = thread?.runtimeMode ?? "full-access";
  const interactionMode: ProviderInteractionMode = thread?.interactionMode ?? "default";
  const sideChatSource: SideChatSource | null =
    data.environmentId !== null && data.directorProjectId !== null && thread?.modelSelection
      ? {
          environmentId: data.environmentId,
          projectId: data.directorProjectId as ProjectId,
          modelSelection: thread.modelSelection,
          runtimeMode,
          interactionMode,
        }
      : null;

  const sendToDirector = (text: string, attachments: Parameters<typeof commands.send>[0]["attachments"] = []) => {
    const ref = data.directorRef;
    if (ref === null) return Promise.resolve(false);
    return commands.send({
      environmentId: ref.environmentId,
      threadId: ref.threadId,
      text,
      attachments,
      runtimeMode,
      interactionMode,
    });
  };

  // Collapses the card at once so a second click cannot answer twice.
  const answering = useRef(new Set<string>());
  const markAnswered = (card: ActionCard, label: string) => {
    answering.current.add(card.id);
    setAnsweredLocally((current) => new Map(current).set(card.id, label));
  };
  // A failed answer reopens the card so it can be tried again.
  const reopen = (card: ActionCard) =>
    setAnsweredLocally((current) => {
      answering.current.delete(card.id);
      const next = new Map(current);
      next.delete(card.id);
      return next;
    });

  const pick = (card: ActionCard, option: ActionCardOption) => {
    if (card.answered !== null || answering.current.has(card.id)) return;
    if (card.kind === "result") {
      if (option.value === RESULT_APPROVE_LABEL) {
        // Asks the Director to merge; the screen never merges by itself.
        markAnswered(card, option.label);
        void sendToDirector(resultMergeRequestMessage(card)).then((sent) => {
          if (!sent) reopen(card);
        });
      } else if (option.value === RESULT_FIX_LABEL) {
        composerRef.current?.setText(resultFixMessage(card));
      }
      return;
    }
    if (card.kind === "plan" && option.value === PLAN_CHANGE_LABEL) {
      composerRef.current?.setText(`Changes for ${card.taskTitle}: `);
      return;
    }
    if (
      card.attentionItemId === null ||
      card.attentionProjectId === null ||
      data.environmentId === null
    ) {
      return;
    }
    markAnswered(card, option.label);
    // The failure itself is reported by the command's toast.
    void answerDecision(data.environmentId, {
      projectId: card.attentionProjectId as ProjectId,
      attentionItemId: card.attentionItemId as never,
      answer: option.value,
    }).then(
      (result) => {
        if (result._tag !== "Success") reopen(card);
      },
      () => reopen(card),
    );
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, keybindings) !== SIDE_CHAT_COMMAND) return;
      event.preventDefault();
      if (!event.repeat) setSideChatOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  return (
    <div data-one-chat-screen className="flex h-dvh min-h-0 w-full flex-col bg-background">
      <header className="flex shrink-0 items-center gap-1 border-b px-4 py-2">
        <h1 className="me-auto font-semibold text-sm">BusyBoy</h1>
        <Button size="xs" variant="ghost" onClick={() => setSideChatOpen(true)}>
          Side chat
          <kbd className="text-muted-foreground text-xs">⌘⇧S</kbd>
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void updateClientSettings({ oneChatScreenEnabled: false })}
        >
          Classic screen
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void navigate({ to: "/settings/general" })}
        >
          Settings
        </Button>
      </header>
      <OneChatFeed
        messages={director.messages}
        cards={cards}
        running={director.running}
        threadRef={data.directorRef}
        environmentId={data.environmentId}
        onPick={pick}
        onOpenDetails={(card) => setDetailsCardId(card.id)}
      />
      <div className="flex shrink-0 flex-col gap-2 px-4 pb-4">
        <WorkToast
          items={data.workItems}
          counts={data.counts}
          environmentId={data.environmentId}
          lookup={lookup}
        />
        <OneChatComposer
          ref={composerRef}
          draftKey={
            data.directorRef === null
              ? null
              : `${data.directorRef.environmentId}:${data.directorRef.threadId}`
          }
          running={director.running}
          disabled={data.directorRef === null}
          mentions={mentions}
          onSend={(text, attachments) => sendToDirector(text, attachments)}
          onStop={() => {
            const ref = data.directorRef;
            if (ref !== null) void commands.stop(ref.environmentId, ref.threadId);
          }}
          onSideChat={() => setSideChatOpen(true)}
        />
      </div>
      <ActionCardModal
        card={detailsCard}
        environmentId={data.environmentId}
        onOpenChange={(open) => {
          if (!open) setDetailsCardId(null);
        }}
        onPick={pick}
      />
      <SideChat
        open={sideChatOpen}
        onOpenChange={setSideChatOpen}
        source={sideChatSource}
        commands={commands}
        onQuote={(text) => composerRef.current?.insertText(quoteForComposer(text))}
      />
    </div>
  );
}
