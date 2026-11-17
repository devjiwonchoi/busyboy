"use client";

import { ArrowUp, Mic, Plus, Square, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";

import { composerSkillsAction, projectFilesAction } from "@/app/(main)/composer-actions";
import { Button } from "@/components/ui/button";
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerItem,
  type ComposerItemValue,
  ComposerList,
  ComposerPopup,
  ComposerSubmit,
  type ComposerValue,
  getComposerText,
  useComposerContext,
} from "@/components/ui/composer";
import { attachmentProblem, imageMediaType, type AttachmentInput } from "@/lib/chat-attachments";
import type { ComposerSkill } from "@/server/skills";

export type ComposerMessage = { text: string; attachments: AttachmentInput[] };

type DraftAttachment = AttachmentInput & { id: string; bytes: number; previewUrl?: string };

export type ChatComposerHandle = { addFiles: (files: FileList | File[]) => void };

export function draftStorageKey(chatId: string) {
  return `busyboy.composer-draft.${chatId}`;
}

function readDraft(chatId: string) {
  try {
    return window.localStorage.getItem(draftStorageKey(chatId)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(chatId: string, text: string) {
  try {
    if (text) window.localStorage.setItem(draftStorageKey(chatId), text);
    else window.localStorage.removeItem(draftStorageKey(chatId));
  } catch {
    // Private mode and a full disk still leave the draft in memory for this view.
  }
}

// ArrowUp in an empty box only edits the previous message. A global binding would take the key from every field.
export const ChatComposer = forwardRef<
  ChatComposerHandle,
  {
    projects: string[];
    filesProject?: string | null;
    showCommands?: boolean;
    canStop?: boolean;
    canArchive?: boolean;
    onCommand?: (command: "stop" | "archive") => void;
    placeholder: string;
    onSend: (message: ComposerMessage) => Promise<void> | void;
    onStop?: () => void;
    label?: string;
    sendLabel?: string;
    leading?: ReactNode;
    draftKey?: string;
    onEmptyArrowUp?: () => void;
    onTextChange?: (text: string) => void;
    seed?: { token: number; text: string } | null;
  }
>(function ChatComposer(
  {
    projects,
    filesProject,
    showCommands = true,
    canStop = false,
    canArchive = false,
    onCommand,
    placeholder,
    onSend,
    onStop,
    label = "Message",
    sendLabel = "Send",
    leading,
    draftKey,
    onEmptyArrowUp,
    onTextChange,
    seed,
  },
  ref,
) {
  const [value, setValue] = useState<ComposerValue>([]);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [queryCharacter, setQueryCharacter] = useState<string | null>(null);
  const [canDictate, setCanDictate] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [skills, setSkills] = useState<ComposerSkill[]>([]);
  const [files, setFiles] = useState<{ path: string }[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickerId = useId();
  const valueRef = useRef(value);
  valueRef.current = value;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const restored = useRef(!draftKey);
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  const onEmptyArrowUpRef = useRef(onEmptyArrowUp);
  onEmptyArrowUpRef.current = onEmptyArrowUp;
  const appliedSeed = useRef<number | null>(null);
  const dictation = useRef<DictationSession | null>(null);
  const appendDictationRef = useRef<(transcript: string) => void>(() => {});

  useEffect(() => {
    setCanDictate(dictationConstructor() !== null);
    return () => {
      const session = dictation.current;
      dictation.current = null;
      if (session) {
        session.onresult = null;
        session.onerror = null;
        session.onend = null;
        session.abort();
      }
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  useEffect(() => {
    let current = true;
    void composerSkillsAction(filesProject ?? undefined)
      .then((next) => {
        if (current) setSkills(next);
      })
      .catch(() => {
        if (current) setSkills([]);
      });
    return () => {
      current = false;
    };
  }, [filesProject]);

  useEffect(() => {
    if (!filesProject) {
      setFiles([]);
      return;
    }
    let current = true;
    void projectFilesAction(filesProject)
      .then((next) => {
        if (current) setFiles(next);
      })
      .catch(() => {
        if (current) setFiles([]);
      });
    return () => {
      current = false;
    };
  }, [filesProject]);

  // Plain text would match the query again and reopen the picker, so the next Enter would pick instead of send.
  const projectItems: ComposerItemValue[] = projects.map((name) => ({
    id: `project:${name}`,
    label: name,
    kind: "project",
  }));
  const fileItems: ComposerItemValue[] = files.map((file) => {
    const slash = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"));
    return {
      id: `file:${file.path}`,
      label: slash === -1 ? file.path : file.path.slice(slash + 1),
      description: file.path,
      kind: "file",
      text: `@${file.path}`,
    };
  });
  const skillItems: ComposerItemValue[] = skills.map((skill) => ({
    id: `skill:${skill.name}`,
    label: skill.name,
    description: skill.description,
    kind: "skill",
    text: skill.invocation,
  }));
  const commandItems: ComposerItemValue[] = showCommands
    ? [
        {
          id: "command:new-task",
          label: "new task",
          description: "Start a task in one project.",
          kind: "command",
          type: "text",
          text: "Create a task: ",
        },
        {
          id: "command:stop",
          label: "stop",
          description: "Stop the reply that is running.",
          kind: "command",
          type: "action",
          disabled: !canStop,
        },
        {
          id: "command:archive",
          label: "archive",
          description: "Put away the task you are messaging.",
          kind: "command",
          type: "action",
          disabled: !canArchive,
        },
      ]
    : [];

  appendDictationRef.current = (transcript: string) => {
    const spoken = transcript.replace(/\s+/g, " ").trim();
    if (!spoken) return;
    const current = valueRef.current;
    const existing = getComposerText(current);
    const gap = existing.length > 0 && !/\s$/.test(existing) ? " " : "";
    commit(withAppendedText(current, gap + spoken));
  };

  function stopDictation() {
    const session = dictation.current;
    dictation.current = null;
    setDictating(false);
    session?.stop();
  }

  function toggleDictation() {
    if (dictation.current) {
      stopDictation();
      return;
    }
    const Dictation = dictationConstructor();
    if (!Dictation) {
      setCanDictate(false);
      return;
    }
    const session = new Dictation();
    session.continuous = true;
    session.interimResults = false;
    session.lang = navigator.language || "en-US";
    session.onresult = (event) => {
      let spoken = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) spoken += result[0]?.transcript ?? "";
      }
      appendDictationRef.current(spoken);
    };
    session.onerror = (event) => {
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "audio-capture"
      ) {
        setError("The microphone could not be used.");
      }
      dictation.current = null;
      setDictating(false);
    };
    session.onend = () => {
      if (dictation.current === session) dictation.current = null;
      setDictating(false);
    };
    try {
      session.start();
    } catch {
      setCanDictate(false);
      return;
    }
    dictation.current = session;
    setDictating(true);
    setError(null);
  }

  function persist(next: ComposerValue) {
    const text = getComposerText(next);
    if (draftKey && restored.current) writeDraft(draftKey, text);
    onTextChangeRef.current?.(text);
  }

  function commit(next: ComposerValue) {
    setValue(next);
    persist(next);
  }

  function change(next: ComposerValue) {
    const command = next.find((part) => part.type === "action" && part.kind === "command");
    if (command && command.type === "action") {
      if (command.id === "command:stop") onCommand?.("stop");
      if (command.id === "command:archive") onCommand?.("archive");
      commit(next.filter((part) => part !== command));
      return;
    }
    commit(next);
  }

  useEffect(() => {
    if (!draftKey) {
      restored.current = true;
      return;
    }
    const saved = readDraft(draftKey);
    restored.current = true;
    if (saved) setValue([{ type: "text", text: saved }]);
    onTextChangeRef.current?.(saved);
  }, [draftKey]);

  const seedToken = seed?.token;
  const seedText = seed?.text;
  useEffect(() => {
    if (seedToken === undefined || seedText === undefined) return;
    if (appliedSeed.current === seedToken) return;
    appliedSeed.current = seedToken;
    setAttachments((current) => {
      release(current);
      return [];
    });
    commit([{ type: "text", text: seedText }]);
    rootRef.current?.querySelector<HTMLElement>('[data-slot="composer-input"]')?.focus();
    // oxlint-disable-next-line react/exhaustive-deps -- appliedSeed runs this once per seed token, and commit is a new function every render
  }, [seedToken, seedText]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.key !== "ArrowUp") return;
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node) || !root.contains(target)) return;
      if (!onEmptyArrowUpRef.current) return;
      // An open @ or / picker owns the arrow keys (it stops the event). This is the extra guard.
      if (
        target instanceof Element &&
        target.closest('[data-slot="composer-input"]')?.hasAttribute("aria-controls")
      )
        return;
      if (getComposerText(valueRef.current).trim() || attachmentsRef.current.length > 0) return;
      event.preventDefault();
      onEmptyArrowUpRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const found = current.find((attachment) => attachment.id === id);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  async function takeFiles(list: FileList | File[]) {
    const incoming = [...list];
    if (incoming.length === 0) return;
    setError(null);
    const next: DraftAttachment[] = [];
    let total = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
    let count = attachments.length;
    try {
      for (const file of incoming) {
        const mediaType = file.type || "application/octet-stream";
        const problem = attachmentProblem({
          name: file.name,
          mediaType,
          bytes: file.size,
          already: count,
          totalBytes: total,
        });
        if (problem) {
          setError(problem);
          break;
        }
        const data = await readBase64(file);
        const preview = imageMediaType(file.name, mediaType)
          ? URL.createObjectURL(file)
          : undefined;
        next.push({
          id: crypto.randomUUID(),
          name: file.name || "file",
          mediaType,
          data,
          bytes: file.size,
          previewUrl: preview,
        });
        total += file.size;
        count += 1;
      }
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message ? reason.message : "The file could not be read.",
      );
    }
    if (next.length > 0) setAttachments((current) => [...current, ...next]);
  }

  useImperativeHandle(ref, () => ({ addFiles: (incoming) => void takeFiles(incoming) }));

  function send(draft: ComposerValue) {
    stopDictation();
    const text = getComposerText(draft).trim();
    const sending = attachments.map(({ name, mediaType, data }) => ({ name, mediaType, data }));
    if (!text && sending.length === 0) return;
    const snapshot = attachments;
    commit([]);
    setAttachments([]);
    setError(null);
    Promise.resolve(onSend({ text, attachments: sending })).then(
      () => release(snapshot),
      () => {
        if (!getComposerText(valueRef.current).trim() && text) commit([{ type: "text", text }]);
        setAttachments((current) => {
          if (current.length > 0) {
            release(snapshot);
            return current;
          }
          return snapshot;
        });
      },
    );
  }

  function onDragOver(event: ReactDragEvent) {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  }

  const fileMentions = Boolean(filesProject);
  const listLabel =
    queryCharacter === "/"
      ? "Choose a skill or command"
      : fileMentions
        ? "Choose a file"
        : "Choose a project";

  return (
    <div
      ref={rootRef}
      data-slot="chat-composer"
      className={`w-full rounded-[1.25rem] border border-zinc-700/80 bg-[#141416] text-zinc-100 ${dragging ? "ring-2 ring-white/30" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        // The chat column also accepts a drop; one drop should add the files once.
        event.stopPropagation();
        setDragging(false);
        void takeFiles(event.dataTransfer.files);
      }}
    >
      {/* Chips sit outside the adaptive grid, which is only plus, input, and send. */}
      {leading && <div className="px-2 pt-2">{leading}</div>}
      {attachments.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 px-2 pt-2">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex items-center gap-1 rounded-xl bg-white/10 p-1">
              {attachment.previewUrl ? (
                // oxlint-disable-next-line nextjs/no-img-element -- a blob preview is not a next/image source
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="size-14 rounded-lg object-cover"
                />
              ) : (
                <span className="max-w-36 truncate px-2 text-xs text-zinc-200">
                  {attachment.name}
                </span>
              )}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="text-zinc-400 hover:bg-white/10 hover:text-white"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Composer
        layout="stacked"
        value={value}
        onValueChange={change}
        onSubmit={send}
        allowEmpty={attachments.length > 0}
        onQueryChange={(query) => setQueryCharacter(query?.character ?? null)}
        onPaste={(event) => {
          const pasted = [...(event.clipboardData?.files ?? [])];
          if (pasted.length === 0) return;
          event.preventDefault();
          void takeFiles(pasted);
        }}
        triggers={[
          {
            character: "@",
            items: fileMentions ? fileItems : projectItems,
            filter: fileMentions ? fuzzyMatch : undefined,
          },
          { character: "/", items: [...skillItems, ...commandItems], filter: fuzzyMatch },
        ]}
        className="w-full items-stretch border-0 bg-transparent text-left text-zinc-100 shadow-none ring-0 [--composer-min-rows:1] [--composer-radius:1.25rem]"
      >
        {/* Pin the empty placeholder to the text origin. The field's ::before is absolute
            and otherwise keeps a static position Chromium centers in the line box. */}
        <ComposerInput
          aria-label={label}
          placeholder={placeholder}
          className="text-left text-zinc-100 data-empty:before:top-1 data-empty:before:right-auto data-empty:before:bottom-auto data-empty:before:left-[calc(--spacing(3)-1px)] data-empty:before:w-max data-empty:before:text-left"
        />
        <ComposerPopup className="overflow-hidden border-zinc-700 shadow-xl">
          <div className="mention-menu">
            <ComposerList aria-label={listLabel}>
              {(item: ComposerItemValue) => (
                <ComposerItem key={item.id} value={item} className="text-inherit">
                  <PickerRow item={item} prefix={item.kind === "project" ? "@" : undefined} />
                </ComposerItem>
              )}
            </ComposerList>
          </div>
        </ComposerPopup>
        <ComposerActions className="items-center justify-between">
          <ComposerActionGroup align="start">
            <input
              id={pickerId}
              ref={picker}
              type="file"
              multiple
              className="sr-only"
              aria-label="Choose a file"
              onChange={(event) => {
                if (event.target.files) void takeFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="rounded-full text-zinc-300 hover:bg-white/10 hover:text-white"
              aria-label="Add attachment"
              onClick={() => picker.current?.click()}
            >
              <Plus />
            </Button>
          </ComposerActionGroup>
          <ComposerActionGroup align="end">
            {onStop && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="rounded-full border-zinc-600 text-zinc-200"
                aria-label="Stop"
                onClick={onStop}
              >
                <Square />
              </Button>
            )}
            {canDictate && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={
                  dictating
                    ? "rounded-full text-red-400 hover:bg-white/10"
                    : "rounded-full text-zinc-300 hover:bg-white/10 hover:text-white"
                }
                aria-label="Dictate"
                aria-pressed={dictating}
                onClick={toggleDictation}
              >
                <Mic />
              </Button>
            )}
            <ComposerSubmit render={<RoundSendButton label={sendLabel} />} />
          </ComposerActionGroup>
        </ComposerActions>
      </Composer>
      {error && (
        <p role="alert" className="px-3 pt-1 pb-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
});

function PickerRow({ item, prefix }: { item: ComposerItemValue; prefix?: string }) {
  const kind = item.kind === "skill" ? "Skill" : item.kind === "command" ? "Command" : null;
  return (
    <span className="flex min-w-0 flex-1 flex-col py-0.5">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium">
          {prefix}
          {item.label}
        </span>
        {kind && (
          <span className="shrink-0 text-[10px] tracking-wide uppercase opacity-50">{kind}</span>
        )}
      </span>
      {item.description && <span className="truncate text-xs opacity-60">{item.description}</span>}
    </span>
  );
}

function fuzzyMatch(item: ComposerItemValue, query: string) {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return true;
  const label = item.label.toLowerCase();
  let from = 0;
  let named = true;
  for (const character of needle) {
    const found = label.indexOf(character, from);
    if (found === -1) {
      named = false;
      break;
    }
    from = found + 1;
  }
  return named || (item.description ?? "").toLowerCase().includes(needle);
}

function RoundSendButton({
  label,
  className,
  ...props
}: { label: string } & ComponentProps<typeof Button>) {
  const { canSubmit } = useComposerContext();
  return (
    <Button
      {...props}
      size="icon"
      aria-label={label}
      className={`${className ?? ""} rounded-full disabled:opacity-100 ${canSubmit ? "bg-white text-black hover:bg-zinc-200" : "bg-white/15 text-zinc-500 hover:bg-white/15"}`}
    >
      <ArrowUp />
    </Button>
  );
}

function withAppendedText(current: ComposerValue, addition: string): ComposerValue {
  const last = current.at(-1);
  if (last && last.type === "text")
    return [...current.slice(0, -1), { type: "text", text: last.text + addition }];
  return [...current, { type: "text", text: addition }];
}

type DictationResult = { isFinal: boolean; 0?: { transcript: string } };

type DictationEvent = { resultIndex: number; results: ArrayLike<DictationResult> };

type DictationSession = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: DictationEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function dictationConstructor(): (new () => DictationSession) | null {
  if (typeof window === "undefined") return null;
  const host = window as Window & {
    SpeechRecognition?: new () => DictationSession;
    webkitSpeechRecognition?: new () => DictationSession;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

function release(drafts: DraftAttachment[]) {
  for (const draft of drafts) {
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  }
}

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}
