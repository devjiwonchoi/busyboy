import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, type UploadChatAttachment } from "@t3tools/contracts";
import {
  isSideChatCommand,
  mentionQueryAt,
  type ProjectMentionStatus,
  projectMentionHandle,
} from "@t3tools/shared/one-chat";
import { ImageIcon, SquareIcon, XIcon } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { readFileAsDataUrl } from "~/lib/imageCompression";
import { cn } from "~/lib/utils";
import { filterMentions, ProjectMentionMenu } from "./project-mention-menu";

export interface OneChatComposerHandle {
  /** Adds text at the caret, then focuses. */
  insertText: (text: string) => void;
  /** Replaces the whole draft, then focuses with the caret at the end. */
  setText: (text: string) => void;
  focus: () => void;
}

interface PendingImage {
  readonly id: string;
  readonly file: File;
}

export const COMPOSER_PLACEHOLDER = "What should we do? @ for a project, /side for a side chat";

let nextImageId = 0;

const draftStorageKey = (key: string) => `one-chat-draft:${key}`;

function readDraft(key: string | null): string {
  if (key === null) return "";
  try {
    return window.localStorage.getItem(draftStorageKey(key)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string | null, text: string) {
  if (key === null) return;
  try {
    if (text.length === 0) window.localStorage.removeItem(draftStorageKey(key));
    else window.localStorage.setItem(draftStorageKey(key), text);
  } catch {
    // Storage can be full or blocked; the draft only lives in memory then.
  }
}

async function toAttachment(file: File): Promise<UploadChatAttachment> {
  return {
    type: "image",
    name: file.name || "image",
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl: await readFileAsDataUrl(file),
  };
}

/** The one chat composer: plain multiline text, @ project mentions, images, and stop. */
export function OneChatComposer({
  ref,
  draftKey,
  running,
  disabled,
  mentions,
  placeholder = COMPOSER_PLACEHOLDER,
  label = "Message",
  onSend,
  onStop,
  onSideChat,
}: {
  ref?: Ref<OneChatComposerHandle>;
  /** Where the draft is kept between reloads; null keeps it in memory only. */
  draftKey: string | null;
  running: boolean;
  disabled?: boolean;
  /** Projects for @; empty turns the menu off. */
  mentions: ReadonlyArray<ProjectMentionStatus>;
  placeholder?: string;
  label?: string;
  onSend: (text: string, attachments: ReadonlyArray<UploadChatAttachment>) => Promise<boolean>;
  onStop?: () => void;
  /** Called for "/side"; when absent, "/side" is sent like any other text. */
  onSideChat?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setTextState] = useState(() => readDraft(draftKey));
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<ReadonlyArray<PendingImage>>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Another thread's draft comes back when the key changes.
  const [loadedKey, setLoadedKey] = useState(draftKey);
  if (loadedKey !== draftKey) {
    setLoadedKey(draftKey);
    setTextState(readDraft(draftKey));
  }

  const update = (next: string, nextCaret = next.length) => {
    setTextState(next);
    setCaret(nextCaret);
    setMentionClosed(false);
    writeDraft(draftKey, next);
  };

  const placeCaret = (position: number) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  useImperativeHandle(ref, () => ({
    insertText: (insert) => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? text.length;
      const end = textarea?.selectionEnd ?? text.length;
      const next = text.slice(0, start) + insert + text.slice(end);
      update(next, start + insert.length);
      placeCaret(start + insert.length);
    },
    setText: (next) => {
      update(next);
      placeCaret(next.length);
    },
    focus: () => textareaRef.current?.focus(),
  }));

  const mention = mentions.length > 0 && !mentionClosed ? mentionQueryAt(text, caret) : null;
  const mentionItems = mention === null ? [] : filterMentions(mentions, mention.query);
  const menuOpen = mentionItems.length > 0;
  const activeMention = Math.min(mentionIndex, Math.max(0, mentionItems.length - 1));

  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.query]);

  const pickMention = (status: ProjectMentionStatus) => {
    if (mention === null) return;
    const insert = `@${projectMentionHandle(status.name)} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    const position = mention.start + insert.length;
    update(next, position);
    placeCaret(position);
  };

  const addFiles = (files: ReadonlyArray<File>) => {
    const accepted: PendingImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setError("Only images can be attached here.");
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        setError(`${file.name} is too large.`);
        continue;
      }
      nextImageId += 1;
      accepted.push({ id: `image-${nextImageId}`, file });
    }
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
  };

  const send = async () => {
    if (sending || disabled) return;
    const trimmed = text.trim();
    if (onSideChat && isSideChatCommand(text) && images.length === 0) {
      update("");
      onSideChat();
      return;
    }
    if (trimmed.length === 0 && images.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const attachments = await Promise.all(images.map((image) => toAttachment(image.file)));
      const sent = await onSend(trimmed, attachments);
      if (sent) {
        update("");
        setImages([]);
      } else {
        setError("Could not send. Try again.");
      }
    } catch {
      setError("Could not send. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      data-one-chat-composer
      className={cn(
        "relative mx-auto flex w-full max-w-3xl flex-col gap-1.5 rounded-2xl border bg-card px-3 py-2",
        dragging && "ring-2 ring-primary",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setDragging(false);
        addFiles([...event.dataTransfer.files]);
      }}
    >
      {menuOpen ? (
        <ProjectMentionMenu
          items={mentionItems}
          activeIndex={activeMention}
          onPick={pickMention}
          onHover={setMentionIndex}
        />
      ) : null}
      {images.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Attachments">
          {images.map((image) => (
            <li
              key={image.id}
              data-one-chat-attachment
              className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
            >
              <span className="max-w-40 truncate">{image.file.name || "image"}</span>
              <button
                type="button"
                aria-label="Remove attachment"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setImages(images.filter((entry) => entry.id !== image.id))}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={textareaRef}
        aria-label={label}
        placeholder={placeholder}
        rows={2}
        value={text}
        disabled={disabled}
        className="max-h-60 min-h-12 w-full resize-none bg-transparent text-sm outline-none"
        onChange={(event) => update(event.target.value, event.target.selectionStart)}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          addFiles(files);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (menuOpen) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setMentionIndex((activeMention + 1) % mentionItems.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setMentionIndex((activeMention - 1 + mentionItems.length) % mentionItems.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pickMention(mentionItems[activeMention]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMentionClosed(true);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-one-chat-file-input
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Attach image"
          onClick={() => fileInputRef.current?.click()}
        >
          <ImageIcon />
        </Button>
        {error ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {error}
          </p>
        ) : null}
        {running && onStop ? (
          <Button size="sm" variant="outline" className="ms-auto" onClick={onStop}>
            <SquareIcon />
            Stop
          </Button>
        ) : null}
        <Button
          size="sm"
          className={running && onStop ? undefined : "ms-auto"}
          disabled={sending || disabled || (text.trim().length === 0 && images.length === 0)}
          onClick={() => void send()}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
