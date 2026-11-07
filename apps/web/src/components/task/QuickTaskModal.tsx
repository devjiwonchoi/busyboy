import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type ProjectId,
  type ProjectTeamTaskDetail,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  BoxIcon,
  ChevronRightIcon,
  CircleEllipsisIcon,
  CircleIcon,
  FileIcon,
  Maximize2Icon,
  Minimize2Icon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "~/lib/attachmentUploadQueue";
import { prepareImageForAttachment } from "~/lib/imageCompression";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { useCreateTask } from "~/state/projectTeam";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Switch } from "../ui/switch";
import { deriveTaskTitle, quickTaskProjectKey } from "./quickTask.logic";

export interface QuickTaskProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
}

type QuickTaskAttachment = ComposerImageAttachment | ComposerFileAttachment;

/** "plan": the PM starts planning right away. "todo": the task waits in Todo. */
type StartMode = "plan" | "todo";

const START_MODES: ReadonlyArray<{ value: StartMode; label: string; icon: ReactNode }> = [
  {
    value: "plan",
    label: "Plan now",
    icon: <CircleEllipsisIcon className="text-orange-600 dark:text-orange-300" />,
  },
  { value: "todo", label: "Save as Todo", icon: <CircleIcon className="text-muted-foreground" /> },
];

const PILL_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-full border border-border/70 bg-transparent px-2.5 text-xs text-foreground/80 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 data-popup-open:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0";

const ICON_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

/**
 * Linear-style quick capture: a title, a description (text, pasted or dropped
 * images and files), a project and whether to plan now. Creates the task and,
 * with "Plan now", the PM starts planning it right away.
 */
export function QuickTaskModal(props: {
  open: boolean;
  projects: ReadonlyArray<QuickTaskProject>;
  /** Preselected project key (see quickTaskProjectKey). */
  initialProjectKey: string | null;
  onClose: () => void;
  /** `keepOpen` is true when "Create more" is on: the composer stays for the next task. */
  onCreated: (
    detail: ProjectTeamTaskDetail,
    project: QuickTaskProject,
    options: { keepOpen: boolean; startPlanning: boolean },
  ) => void;
}) {
  const createTask = useCreateTask();
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [startMode, setStartMode] = useState<StartMode>("plan");
  const [createMore, setCreateMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [attachments, setAttachments] = useState<QuickTaskAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);

  const { open, projects, initialProjectKey } = props;
  // Each opening starts from the opener's project.
  useEffect(() => {
    if (open) setProjectKey(initialProjectKey);
  }, [open, initialProjectKey]);

  const project =
    projects.find((candidate) => quickTaskProjectKey(candidate) === projectKey) ??
    projects[0] ??
    null;

  const reset = () => {
    for (const attachment of attachments) {
      releaseAttachmentUpload(attachment.id);
      if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
    }
    setTitle("");
    setContext("");
    setAttachments([]);
    setError(null);
  };

  const close = () => {
    if (sending) return;
    reset();
    setExpanded(false);
    props.onClose();
  };

  const addFiles = async (files: ReadonlyArray<File>) => {
    if (project === null || files.length === 0) return;
    const added: QuickTaskAttachment[] = [];
    let problem: string | null = null;
    for (const file of files) {
      if (attachments.length + added.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        problem = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files.`;
        break;
      }
      const kind = classifyComposerAttachmentFile(file);
      if (kind === "unsupported-image") {
        problem = `'${file.name}' is not a supported image type.`;
        continue;
      }
      if (kind === "image") {
        const prepared = await prepareImageForAttachment(
          normalizeComposerImageFileMimeType(file),
          PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
        );
        if (!prepared.ok) {
          problem = `'${file.name}' could not be attached.`;
          continue;
        }
        added.push({
          type: "image",
          id: randomUUID(),
          name: prepared.file.name || "image",
          mimeType: prepared.file.type,
          sizeBytes: prepared.file.size,
          previewUrl: URL.createObjectURL(prepared.file),
          file: prepared.file,
        });
        continue;
      }
      if (file.size <= 0 || file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        problem = `'${file.name}' is empty or too large to attach.`;
        continue;
      }
      added.push({
        type: "file",
        id: randomUUID(),
        name: file.name || "file",
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        file,
      });
    }
    for (const attachment of added) {
      startAttachmentUpload({ environmentId: project.environmentId, image: attachment });
    }
    setAttachments((current) => [...current, ...added]);
    setError(problem);
  };

  const removeAttachment = (attachment: QuickTaskAttachment) => {
    releaseAttachmentUpload(attachment.id);
    if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((candidate) => candidate.id !== attachment.id));
  };

  const submit = async () => {
    if (project === null || sending) return;
    const taskTitle = title.trim() || deriveTaskTitle(context);
    if (taskTitle.length === 0) {
      setError("Describe the task first.");
      titleRef.current?.focus();
      return;
    }
    setSending(true);
    setError(null);
    // Uploads target one environment; switching to a project elsewhere re-uploads.
    for (const attachment of attachments) {
      startAttachmentUpload({ environmentId: project.environmentId, image: attachment });
    }
    await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
    const uploaded = getUploadedAttachments({
      environmentId: project.environmentId,
      images: attachments,
    });
    if (uploaded === null) {
      setSending(false);
      setError("An attachment did not upload. Remove it or try again.");
      return;
    }
    const startPlanning = startMode === "plan";
    const result = await createTask(project.environmentId, {
      projectId: project.projectId,
      title: taskTitle,
      context,
      startPlanning,
      ...(uploaded.length > 0 ? { attachments: uploaded } : {}),
    });
    setSending(false);
    if (!AsyncResult.isSuccess(result)) {
      setError("Could not create the task. Try again.");
      return;
    }
    reset();
    if (createMore) {
      titleRef.current?.focus();
    } else {
      setExpanded(false);
    }
    props.onCreated(result.value, project, { keepOpen: createMore, startPlanning });
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const handlePaste = (event: ReactClipboardEvent) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const handleDrop = (event: ReactDragEvent) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  const submitHint = isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl+↵";
  const disabled = sending || project === null;
  const mode = START_MODES.find((candidate) => candidate.value === startMode) ?? START_MODES[0]!;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPrimitive.Portal>
        {/* A light dim, not a blur: the app stays readable behind the composer. */}
        <DialogPrimitive.Backdrop
          data-slot="quick-task-backdrop"
          className="fixed inset-0 z-50 bg-black/25 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/45"
        />
        <DialogPrimitive.Viewport
          className={cn(
            "fixed inset-0 z-50 flex justify-center [-webkit-app-region:no-drag]",
            expanded ? "items-center p-6" : "items-start px-4 pt-[12vh]",
            "max-sm:items-end max-sm:p-0 max-sm:pt-12",
          )}
        >
          <DialogPrimitive.Popup
            data-slot="quick-task-composer"
            data-expanded={expanded ? "" : undefined}
            className={cn(
              "relative flex w-full flex-col rounded-2xl border border-border/80 bg-popover text-popover-foreground shadow-[0_24px_60px_-20px_rgb(0_0_0/45%)] outline-none transition-[opacity,scale,translate] duration-150 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 dark:border-white/10 dark:shadow-[0_24px_60px_-16px_rgb(0_0_0/80%)]",
              expanded ? "h-full max-h-[880px] max-w-[1080px]" : "max-h-[76vh] max-w-[720px]",
              "max-sm:max-h-[calc(100dvh-3rem)] max-sm:max-w-none max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4",
              dragging && "ring-2 ring-primary/60",
            )}
            onKeyDown={handleKeyDown}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setDragging(false);
            }}
            onDrop={handleDrop}
          >
            {/* Header: project › New task, then expand and close. */}
            <div className="flex items-center gap-1.5 py-2.5 ps-3.5 pe-2.5">
              <span
                data-testid="quick-task-project-chip"
                className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-muted/50 px-2 font-medium text-foreground/80 text-xs"
              >
                <BoxIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="max-w-48 truncate">{project?.name ?? "No project"}</span>
              </span>
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <DialogPrimitive.Title className="font-normal text-foreground text-sm">
                New task
              </DialogPrimitive.Title>
              <span className="flex-1" />
              <button
                type="button"
                aria-label={expanded ? "Collapse" : "Expand"}
                aria-pressed={expanded}
                className={cn(ICON_BUTTON_CLASS, "max-sm:hidden [&_svg]:size-3.5")}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
              </button>
              <DialogPrimitive.Close aria-label="Close" className={ICON_BUTTON_CLASS}>
                <XIcon />
              </DialogPrimitive.Close>
            </div>

            {/* Body: borderless title and a description that grows with its content. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
              {projects.length === 0 ? (
                <p className="pb-2 text-muted-foreground text-sm">
                  No project has a project manager yet. Set one up in a project first.
                </p>
              ) : null}
              <input
                ref={titleRef}
                autoFocus
                aria-label="Task title"
                placeholder="Task title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onPaste={handlePaste}
                className="w-full bg-transparent py-1 font-medium text-foreground text-lg leading-7 outline-none placeholder:text-muted-foreground/60"
              />
              <textarea
                aria-label="Task description"
                placeholder="Add description…"
                value={context}
                onChange={(event) => setContext(event.target.value)}
                onPaste={handlePaste}
                className={cn(
                  "field-sizing-content w-full resize-none bg-transparent py-1.5 text-[15px] text-foreground leading-6 outline-none placeholder:text-muted-foreground/60",
                  expanded ? "min-h-48 flex-1" : "min-h-16",
                )}
              />
              {attachments.length > 0 ? (
                <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 pt-1 pb-2">
                  {attachments.map((attachment) => {
                    const upload = uploads[attachment.id];
                    return (
                      <li
                        key={attachment.id}
                        className="flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 ps-1 pe-1.5 text-xs"
                      >
                        {attachment.type === "image" ? (
                          <img
                            src={attachment.previewUrl}
                            alt=""
                            className="size-5 rounded-sm object-cover"
                          />
                        ) : (
                          <FileIcon className="size-4 text-muted-foreground" />
                        )}
                        <span className="max-w-40 truncate">{attachment.name}</span>
                        {upload?.status === "uploading" ? (
                          <span className="text-muted-foreground">
                            {Math.round(upload.progress * 100)}%
                          </span>
                        ) : upload?.status === "failed" ? (
                          <span className="text-destructive">failed</span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Remove ${attachment.name}`}
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => removeAttachment(attachment)}
                        >
                          <XIcon className="size-3" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>

            {/* Properties that map to real task fields. */}
            <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-2 pb-1">
              <Menu>
                <MenuTrigger
                  aria-label={`Project: ${project?.name ?? "none"}`}
                  disabled={projects.length === 0}
                  className={PILL_CLASS}
                >
                  <BoxIcon className="text-muted-foreground" />
                  <span className="max-w-40 truncate">{project?.name ?? "Project"}</span>
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuRadioGroup
                    value={project === null ? null : quickTaskProjectKey(project)}
                    onValueChange={(value) => {
                      if (typeof value === "string") setProjectKey(value);
                    }}
                  >
                    {projects.map((candidate) => (
                      <MenuRadioItem
                        key={quickTaskProjectKey(candidate)}
                        value={quickTaskProjectKey(candidate)}
                      >
                        <span className="flex items-center gap-2">
                          <span className="flex-1 truncate">{candidate.name}</span>
                          <MenuRadioItemIndicator />
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
              <Menu>
                <MenuTrigger aria-label={`Start: ${mode.label}`} className={PILL_CLASS}>
                  {mode.icon}
                  {mode.label}
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuRadioGroup
                    value={startMode}
                    onValueChange={(value) => {
                      if (value === "plan" || value === "todo") setStartMode(value);
                    }}
                  >
                    {START_MODES.map((candidate) => (
                      <MenuRadioItem key={candidate.value} value={candidate.value}>
                        <span className="flex items-center gap-2">
                          {candidate.icon}
                          <span className="flex-1">{candidate.label}</span>
                          <MenuRadioItemIndicator />
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
            </div>

            {error ? <p className="px-4 pt-1 text-destructive text-xs">{error}</p> : null}

            {/* Footer: attach on the left; Create more and Create task on the right. */}
            <div className="flex items-center gap-3 px-3.5 pt-2 pb-3">
              <button
                type="button"
                aria-label="Attach files"
                disabled={disabled}
                className="inline-flex size-8 items-center justify-center rounded-full border border-border/70 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_svg]:size-4"
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperclipIcon />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void addFiles(files);
                }}
              />
              <span className="flex-1" />
              <label className="flex cursor-pointer select-none items-center gap-2 text-muted-foreground text-sm">
                <Switch size="sm" checked={createMore} onCheckedChange={setCreateMore} />
                Create more
              </label>
              <Button type="button" size="sm" onClick={() => void submit()} disabled={disabled}>
                {sending ? "Creating…" : "Create task"}
                {sending ? null : <span className="opacity-60 max-md:hidden">{submitHint}</span>}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
