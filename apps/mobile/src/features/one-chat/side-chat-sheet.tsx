import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ChatBubble } from "./chat-bubble";
import { OneChatModal } from "./one-chat-modal";
import type { OneChatActions } from "./use-one-chat-actions";
import { useThreadChat } from "./use-one-chat-data";

/**
 * A throwaway chat beside the Director. It opens its own thread, talks only there, and deletes
 * that thread when closed, so nothing reaches the Director thread or any task.
 */
export function SideChatSheet(props: {
  readonly environmentId: EnvironmentId | null;
  readonly actions: Pick<OneChatActions, "createSideChat" | "sendToSideChat" | "deleteSideChat">;
  readonly onQuote: (text: string) => void;
  readonly onClose: () => void;
}) {
  const { actions } = props;
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [text, setText] = useState("");
  const threadRef = useRef<ThreadId | null>(null);
  const closed = useRef(false);
  const chat = useThreadChat(props.environmentId, threadId);

  useEffect(() => {
    closed.current = false;
    void actions.createSideChat().then((created) => {
      if (created === null) return;
      // Closed before the thread existed: delete it right away.
      if (closed.current) {
        void actions.deleteSideChat(created);
        return;
      }
      threadRef.current = created;
      setThreadId(created);
    });
    return () => {
      closed.current = true;
      if (threadRef.current !== null) void actions.deleteSideChat(threadRef.current);
      threadRef.current = null;
    };
    // Opens once per sheet; the actions are stable for the Director thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = () => {
    const message = text.trim();
    if (threadId === null || message.length === 0) return;
    setText("");
    void actions.sendToSideChat(threadId, message);
  };

  return (
    <OneChatModal
      title="Side chat"
      subtitle="Temporary · gone when closed"
      onClose={props.onClose}
      scroll={false}
      testID="side-chat-sheet"
    >
      <ScrollView className="flex-1" contentContainerStyle={{ paddingVertical: 12 }}>
        {chat.messages.map((message) =>
          message.role === "assistant" ? (
            <View key={message.id}>
              <ChatBubble role="assistant" text={message.text} />
              <Pressable
                accessibilityRole="button"
                className="mx-6 mb-2 self-start"
                onPress={() => props.onQuote(message.text)}
              >
                <Text className="text-xs text-primary">Quote in main chat</Text>
              </Pressable>
            </View>
          ) : message.role === "user" ? (
            <ChatBubble key={message.id} role="user" text={message.text} />
          ) : null,
        )}
        {chat.running ? (
          <Text className="mx-4 my-1 text-sm text-foreground-muted">Working…</Text>
        ) : null}
      </ScrollView>
      <View className="mx-3 mb-3 flex-row items-end gap-2 rounded-3xl border border-border bg-card px-3 py-2">
        <TextInput
          accessibilityLabel="Side chat message"
          placeholder="Message"
          multiline
          editable={threadId !== null}
          value={text}
          onChangeText={setText}
          className="max-h-32 flex-1 py-1 text-base text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send side chat message"
          disabled={threadId === null || text.trim().length === 0}
          onPress={send}
          className="rounded-full bg-primary px-3 py-1.5"
        >
          <Text className="text-sm text-primary-foreground">Send</Text>
        </Pressable>
      </View>
    </OneChatModal>
  );
}
