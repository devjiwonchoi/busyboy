import { mentionQueryAt, type ProjectMentionStatus } from "@t3tools/shared/one-chat";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Pressable, TextInput, type TextInputInstance, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { pickComposerImages, type DraftComposerAttachment } from "../../lib/composerImages";
import { ProjectMentionPopover } from "./project-mention-popover";

export interface OneChatComposerHandle {
  readonly insertText: (text: string) => void;
  readonly setText: (text: string) => void;
  readonly focus: () => void;
}

export interface OneChatComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly setText: (text: string) => void;
  readonly addAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => number;
  readonly removeAttachment: (id: string) => void;
}

/** Text, photos, send and stop. @ opens the project list. */
export const OneChatComposer = forwardRef<
  OneChatComposerHandle,
  {
    readonly draft: OneChatComposerDraft;
    readonly disabled: boolean;
    readonly running: boolean;
    readonly mentionProjects: ReadonlyArray<ProjectMentionStatus>;
    readonly onSend: () => void;
    readonly onStop: () => void;
  }
>(function OneChatComposer(props, ref) {
  const { draft } = props;
  const inputRef = useRef<TextInputInstance>(null);
  const [selection, setSelection] = useState({ start: draft.text.length, end: draft.text.length });
  // Only set after an insert; a controlled selection while typing makes the caret jump.
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | null>(
    null,
  );
  const caret = Math.min(selection.end, draft.text.length);
  const latest = useRef({ text: draft.text, caret });
  latest.current = { text: draft.text, caret };

  const replace = (start: number, end: number, value: string) => {
    const { text } = latest.current;
    const next = text.slice(0, start) + value + text.slice(end);
    const position = start + value.length;
    latest.current = { text: next, caret: position };
    draft.setText(next);
    setSelection({ start: position, end: position });
    setForcedSelection({ start: position, end: position });
  };

  useImperativeHandle(ref, () => ({
    insertText: (value) => replace(latest.current.caret, latest.current.caret, value),
    setText: (value) => replace(0, latest.current.text.length, value),
    focus: () => inputRef.current?.focus(),
  }));

  const mention = mentionQueryAt(draft.text, caret);
  const canSend = !props.disabled && (draft.text.trim().length > 0 || draft.attachments.length > 0);

  const pickPhotos = async () => {
    const result = await pickComposerImages({ existingCount: draft.attachments.length });
    const rejected = draft.addAttachments(result.images);
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejected > 0 ? ["Too many attachments for one message."] : []),
    ];
    if (problems.length > 0) Dialog.alert("Could not attach photo", problems.join("\n\n"));
  };

  return (
    <View>
      {mention !== null ? (
        <ProjectMentionPopover
          projects={props.mentionProjects}
          query={mention.query}
          onPick={(handle) => replace(mention.start, caret, `@${handle} `)}
        />
      ) : null}
      {draft.attachments.length > 0 ? (
        <View className="mx-3 mb-1 flex-row flex-wrap gap-2">
          {draft.attachments.map((attachment, index) => (
            <Pressable
              key={attachment.id}
              accessibilityRole="button"
              accessibilityLabel={`Remove attachment ${index + 1}`}
              className="rounded-full border border-border px-2 py-1"
              onPress={() => draft.removeAttachment(attachment.id)}
            >
              <Text className="text-xs text-foreground-secondary">
                {attachment.type === "image" ? "Photo" : attachment.name} ×
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View className="mx-3 flex-row items-end gap-2 rounded-3xl border border-border bg-card px-3 py-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach photo"
          disabled={props.disabled}
          onPress={() => void pickPhotos()}
          className="pb-1"
        >
          <Text className="text-lg text-foreground-secondary">+</Text>
        </Pressable>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message"
          placeholder="Message"
          multiline
          editable={!props.disabled}
          value={draft.text}
          selection={forcedSelection ?? undefined}
          onSelectionChange={(event) => {
            setForcedSelection(null);
            setSelection(event.nativeEvent.selection);
          }}
          onChangeText={(text) => {
            // The caret event can arrive after the text; move the caret by the change until it does.
            const typedCaret = Math.max(
              0,
              Math.min(text.length, latest.current.caret + text.length - latest.current.text.length),
            );
            latest.current = { text, caret: typedCaret };
            setSelection({ start: typedCaret, end: typedCaret });
            draft.setText(text);
          }}
          className="max-h-40 flex-1 py-1 text-base text-foreground"
        />
        {props.running ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop"
            onPress={props.onStop}
            className="rounded-full border border-border px-3 py-1.5"
          >
            <Text className="text-sm">Stop</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!canSend}
          onPress={props.onSend}
          className={`rounded-full px-3 py-1.5 ${canSend ? "bg-primary" : "bg-muted"}`}
        >
          <Text className={`text-sm ${canSend ? "text-primary-foreground" : "text-foreground-muted"}`}>
            Send
          </Text>
        </Pressable>
      </View>
    </View>
  );
});
