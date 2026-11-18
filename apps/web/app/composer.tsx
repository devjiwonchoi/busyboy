import { ArrowUp, FileText, Play, Plus, Square, X } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { attachmentProblem, imageMediaType } from "@/lib/chat-attachments";

import { sendToDirectorAction, stopDirectorAction } from "./director-actions";

type DraftAttachment = { id: string; file: File; previewUrl?: string };

export type ComposerHandle = { addFiles: (files: FileList | File[]) => void };

type ComposerProps = {
  answering: boolean;
  canResume: boolean;
  error?: string;
  onError: (error: string) => void;
  ref?: Ref<ComposerHandle>;
};

export function Composer({ answering, canResume, error, onError, ref }: ComposerProps) {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  async function addFiles(incoming: FileList | File[]) {
    const next: DraftAttachment[] = [];
    let count = attachments.length;
    let total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0);
    for (const original of [...incoming]) {
      let file: File;
      try {
        file = isHeic(original) ? await heicToJpeg(original) : original;
      } catch {
        onError(`${original.name || "That image"} could not be converted from HEIC.`);
        break;
      }
      const problem = attachmentProblem({
        name: file.name,
        mediaType: file.type,
        bytes: file.size,
        already: count,
        totalBytes: total,
      });
      if (problem) {
        onError(problem);
        break;
      }
      const image = imageMediaType(file.name, file.type) !== null;
      next.push({
        id: crypto.randomUUID(),
        file,
        ...(image ? { previewUrl: URL.createObjectURL(file) } : {}),
      });
      count += 1;
      total += file.size;
    }
    if (next.length > 0) setAttachments((current) => [...current, ...next]);
  }

  function removeAttachments(ids: Set<string>) {
    setAttachments((current) =>
      current.filter((attachment) => {
        if (!ids.has(attachment.id)) return true;
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        return false;
      }),
    );
  }

  useImperativeHandle(ref, () => ({ addFiles: (files) => void addFiles(files) }));

  async function send(text: string, files: DraftAttachment[]) {
    const formData = new FormData();
    formData.set("text", text);
    for (const attachment of files) formData.append("files", attachment.file);
    setSending(true);
    const result = await sendToDirectorAction(formData).catch(() => ({
      error: "The message could not be sent. Try again.",
    }));
    setSending(false);
    return result;
  }

  async function submit(form: HTMLFormElement) {
    const field = input.current;
    const text = field?.value ?? "";
    if ((!text.trim() && attachments.length === 0) || answering || sending) return;
    const files = attachments;
    form.reset();
    setHasText(false);
    setAttachments([]);
    const result = await send(text, files);
    if (result.error) {
      onError(result.error);
      if (field && !field.value) {
        field.value = text;
        setHasText(text.trim() !== "");
      }
      setAttachments((current) => [...files, ...current]);
      return;
    }
    for (const attachment of files) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }

  async function resume() {
    const result = await send(RESUME_PROMPT, []);
    if (result.error) onError(result.error);
  }

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, a, input, textarea, li")) return;
          event.preventDefault();
          input.current?.focus();
        }}
        data-dragging={dragging ? "" : undefined}
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          event.stopPropagation();
          void addFiles(event.dataTransfer.files);
        }}
        className="bg-card text-card-foreground focus-within:ring-ring/30 data-dragging:ring-ring/50 flex w-full cursor-text flex-col rounded-3xl border focus-within:ring-2 data-dragging:ring-2"
      >
        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="flex cursor-default flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="bg-muted flex items-center gap-1 rounded-xl p-1">
                {attachment.previewUrl ? (
                  // oxlint-disable-next-line nextjs/no-img-element -- a blob preview is not a next/image source
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.file.name}
                    className="size-14 rounded-lg object-cover"
                  />
                ) : (
                  <span className="flex max-w-40 items-center gap-1 px-1.5 text-xs">
                    <FileText className="size-3.5 shrink-0" />
                    <span className="truncate">{attachment.file.name}</span>
                  </span>
                )}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-full"
                  aria-label={`Remove ${attachment.file.name}`}
                  onClick={() => removeAttachments(new Set([attachment.id]))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-1 p-2">
          <input
            ref={picker}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose files"
            onChange={(event) => {
              if (event.currentTarget.files) void addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            className="rounded-full"
            aria-label="Add files"
            onClick={() => picker.current?.click()}
          >
            <Plus />
          </Button>
          <Textarea
            ref={input}
            name="text"
            aria-label="Message"
            placeholder="Message"
            rows={1}
            required={attachments.length === 0}
            onInput={(event) => setHasText(event.currentTarget.value.trim() !== "")}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files];
              if (pasted.length === 0) return;
              event.preventDefault();
              void addFiles(pasted);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            className="max-h-60 min-h-0 flex-1 self-center rounded-none border-0 bg-transparent px-1 py-1.5 text-sm shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
          />
          <PrimaryAction
            answering={answering || sending}
            empty={!hasText && attachments.length === 0}
            canResume={canResume}
            onResume={() => void resume()}
          />
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-destructive px-2 pt-2 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const ESCAPE_WINDOW_MS = 1500;
const RESUME_PROMPT = "Continue where you left off.";

function PrimaryAction({
  answering,
  empty,
  canResume,
  onResume,
}: {
  answering: boolean;
  empty: boolean;
  canResume: boolean;
  onResume: () => void;
}) {
  const [escapeArmed, setEscapeArmed] = useState(false);
  const armedAt = useRef(0);

  // oxlint-disable-next-line busyboy/no-unreasoned-effect -- listens for Escape twice to stop the reply while one is running.
  useEffect(() => {
    if (!answering) return;
    let lapse: ReturnType<typeof setTimeout> | undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.defaultPrevented || event.isComposing)
        return;
      event.preventDefault();
      clearTimeout(lapse);
      if (Date.now() - armedAt.current > ESCAPE_WINDOW_MS) {
        armedAt.current = Date.now();
        setEscapeArmed(true);
        lapse = setTimeout(() => {
          armedAt.current = 0;
          setEscapeArmed(false);
        }, ESCAPE_WINDOW_MS);
        return;
      }
      armedAt.current = 0;
      setEscapeArmed(false);
      void stopDirectorAction();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(lapse);
      armedAt.current = 0;
      setEscapeArmed(false);
    };
  }, [answering]);

  if (answering) {
    return (
      <Button
        type="button"
        size="icon-lg"
        aria-label={escapeArmed ? "Press Escape again to stop" : "Stop"}
        title="Stop (Esc Esc)"
        onClick={() => void stopDirectorAction()}
        className="rounded-full"
      >
        {escapeArmed ? (
          <span className="text-xs leading-none font-semibold tracking-tighter">Esc</span>
        ) : (
          <Square className="fill-current" />
        )}
      </Button>
    );
  }

  if (canResume && empty) {
    return (
      <Button
        type="button"
        size="icon-lg"
        aria-label="Resume"
        title="Continue where it stopped"
        onClick={onResume}
        className="rounded-full"
      >
        <Play className="fill-current" />
      </Button>
    );
  }

  return (
    <Button
      type="submit"
      size="icon-lg"
      aria-label="Send"
      disabled={empty}
      className="disabled:bg-muted disabled:text-muted-foreground rounded-full disabled:opacity-100"
    >
      <ArrowUp />
    </Button>
  );
}

function isHeic(file: File) {
  if (/^image\/hei[cf]$/i.test(file.type)) return true;
  return (
    (file.type === "" || file.type === "application/octet-stream") && /\.hei[cf]$/i.test(file.name)
  );
}

async function heicToJpeg(file: File) {
  const { heicTo } = await import("heic-to/csp");
  const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 });
  const name = `${(file.name || "image").replace(/\.hei[cf]$/i, "")}.jpg`;
  return new File([jpeg], name, { type: "image/jpeg", lastModified: file.lastModified });
}
