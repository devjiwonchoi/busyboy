import { useAtomSet } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  PLAN_APPROVAL_START,
  type ProjectTaskReference,
} from "@t3tools/contracts";
import {
  isSideChatCommand,
  PLAN_CHANGE_LABEL,
  projectMentionHandle,
  projectMentionStatus,
  quoteForComposer,
  RESULT_APPROVE_LABEL,
  RESULT_FIX_LABEL,
  resultFixMessage,
  resultMergeRequestMessage,
  type ActionCard,
  type ActionCardOption,
} from "@t3tools/shared/one-chat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { ActionCardDetails } from "./action-card-details";
import { OneChatComposer, type OneChatComposerHandle } from "./one-chat-composer";
import { NodeEndStateDetails } from "./node-end-state-details";
import { buildFeedItems, OneChatFeed, type OneChatFeedHandle } from "./one-chat-feed";
import { SideChatSheet } from "./side-chat-sheet";
import { useOneChatActions } from "./use-one-chat-actions";
import { useOneChatData } from "./use-one-chat-data";
import { useOneChatDraft } from "./use-one-chat-draft";
import { WorkToast } from "./work-toast";

const HIGHLIGHT_MS = 1600;

function HeaderMenu(props: {
  readonly onSideChat: () => void;
  readonly onClassic: () => void;
  readonly onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const item = (label: string, action: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="menuitem"
      className="px-4 py-2.5"
      onPress={() => {
        setOpen(false);
        action();
      }}
    >
      <Text className="text-sm">{label}</Text>
    </Pressable>
  );
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More"
        className="px-2 py-1"
        onPress={() => setOpen((value) => !value)}
      >
        <Text className="text-lg text-foreground-secondary">⋯</Text>
      </Pressable>
      {open ? (
        <View
          testID="one-chat-menu"
          className="absolute right-0 top-9 z-10 min-w-40 rounded-xl border border-border bg-card py-1"
        >
          {item("Side chat", props.onSideChat)}
          {item("Classic screen", props.onClassic)}
          {item("Settings", props.onSettings)}
        </View>
      ) : null}
    </View>
  );
}

/** Home as one Director chat, with each project's cards in it and the work toast above. */
export function OneChatScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const data = useOneChatData();
  const actions = useOneChatActions(data);
  const draftKey =
    data.environmentId !== null && data.directorThreadId !== null
      ? scopedThreadKey(data.environmentId, data.directorThreadId)
      : null;
  const draft = useOneChatDraft(draftKey);
  const composerRef = useRef<OneChatComposerHandle>(null);
  const feedRef = useRef<OneChatFeedHandle>(null);
  const [answeredLabels, setAnsweredLabels] = useState<Record<string, string>>({});
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const [detailsCard, setDetailsCard] = useState<ActionCard | null>(null);
  const [detailsNodeId, setDetailsNodeId] = useState<string | null>(null);
  const detailsNode = data.graph?.nodes.find((node) => node.id === detailsNodeId) ?? null;
  const [sideChatOpen, setSideChatOpen] = useState(false);

  // This screen draws its own header; give the stack header back when Home switches screens.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [navigation]);

  useEffect(() => {
    if (highlightedCardId === null) return;
    const timer = setTimeout(() => setHighlightedCardId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedCardId]);

  const feedItems = useMemo(
    () => buildFeedItems(data.chat.messages, data.cards, data.chat.running),
    [data.chat.messages, data.cards, data.chat.running],
  );
  const mentionProjects = useMemo(
    () => projectMentionStatus(data.projects, data.graph),
    [data.projects, data.graph],
  );
  const taskTitle = useCallback(
    (taskId: string) => {
      const node = data.graph?.nodes.find((candidate) => candidate.id === taskId);
      if (node) return node.contract?.title ?? node.id;
      for (const project of data.projects) {
        const task = project.summary.tasks.find(
          (candidate: ProjectTaskReference) => candidate.id === taskId,
        );
        if (task) return task.title;
      }
      return taskId;
    },
    [data.projects, data.graph],
  );

  const markAnswered = (card: ActionCard, label: string) =>
    setAnsweredLabels((current) => ({ ...current, [card.id]: label }));

  const onAnswer = (card: ActionCard, option: ActionCardOption) => {
    if (card.kind === "result") {
      if (option.value === RESULT_APPROVE_LABEL) {
        markAnswered(card, option.label);
        void actions.sendToDirector(resultMergeRequestMessage(card));
      } else if (option.value === RESULT_FIX_LABEL) {
        composerRef.current?.setText(resultFixMessage(card));
        composerRef.current?.focus();
      }
      return;
    }
    if (card.kind === "plan" && option.value === PLAN_CHANGE_LABEL) {
      composerRef.current?.setText(
        `@${projectMentionHandle(card.projectName)} ${card.taskTitle}: change the plan: `,
      );
      composerRef.current?.focus();
      return;
    }
    if (card.attentionItemId === null) return;
    markAnswered(card, option.label);
    void Promise.resolve(
      actions.answerCard(
        card.projectId,
        card.attentionItemId,
        card.kind === "plan" ? PLAN_APPROVAL_START : option.value,
      ),
    ).then((result) => {
      // A failed answer reopens the card so it can be tried again.
      if (result && result._tag !== "Success") {
        setAnsweredLabels(({ [card.id]: _dropped, ...rest }) => rest);
      }
    });
  };

  const onSend = () => {
    const text = draft.text.trim();
    if (isSideChatCommand(text)) {
      draft.setText("");
      setSideChatOpen(true);
      return;
    }
    if (text.length === 0 && draft.attachments.length === 0) return;
    const attachments = draft.attachments;
    draft.clear();
    void actions.sendToDirector(text, attachments);
  };

  const jumpToCard = (cardId: string) => {
    feedRef.current?.scrollToCard(cardId);
    setHighlightedCardId(cardId);
  };

  return (
    <View testID="one-chat-screen" className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <View className="z-10 flex-row items-center justify-between px-4 py-2">
        <Text className="font-t3-bold text-lg">BusyBoy</Text>
        <HeaderMenu
          onSideChat={() => setSideChatOpen(true)}
          onClassic={() => savePreferences({ oneChatScreenEnabled: false })}
          onSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
        />
      </View>
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        <View className="flex-1">
          <OneChatFeed
            ref={feedRef}
            items={feedItems}
            environmentId={data.environmentId}
            answeredLabels={answeredLabels}
            highlightedCardId={highlightedCardId}
            onAnswer={onAnswer}
            onOpenDetails={setDetailsCard}
          />
        </View>
        <WorkToast
          items={data.workItems}
          cards={data.cards}
          taskTitle={taskTitle}
          onJumpToCard={jumpToCard}
          onOpenDetails={setDetailsCard}
          onOpenNode={setDetailsNodeId}
        />
        <View style={{ paddingBottom: Math.max(insets.bottom, 8) }}>
          <OneChatComposer
            ref={composerRef}
            draft={draft}
            disabled={draftKey === null}
            running={data.chat.running}
            mentionProjects={mentionProjects}
            onSend={onSend}
            onStop={() => void actions.stopDirector(data.chat.activeRunId)}
          />
        </View>
      </KeyboardAvoidingView>
      {detailsCard ? (
        <ActionCardDetails
          card={detailsCard}
          environmentId={data.environmentId}
          onClose={() => setDetailsCard(null)}
        />
      ) : null}
      {detailsNode ? (
        <NodeEndStateDetails node={detailsNode} onClose={() => setDetailsNodeId(null)} />
      ) : null}
      {sideChatOpen ? (
        <SideChatSheet
          environmentId={data.environmentId}
          actions={actions}
          onQuote={(text) => composerRef.current?.insertText(quoteForComposer(text))}
          onClose={() => setSideChatOpen(false)}
        />
      ) : null}
    </View>
  );
}
