import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type ProjectId,
  type ProjectTeamTaskDetail,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
import { isMacPlatform, randomUUID } from "~/lib/utils";
import { useCreateTask } from "~/state/projectTeam";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { deriveTaskTitle, quickTaskProjectKey } from "./quickTask.logic";

export interface QuickTaskProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
}

type QuickTaskAttachment = ComposerImageAttachment | ComposerFileAttachment;

/**
 * Linear-style quick capture: dump context (text, pasted or dropped images and
 * files), keep or change the project, submit. The task is created and the PM
 * starts planning it right away.
 */
export function QuickTaskModal(props: {
  open: boolean;
  projects: ReadonlyArray<QuickTaskProject>;
  /** Preselected project key (see quickTaskProjectKey). */
  initialProjectKey: string | null;
  onClose: () => void;
  onCreated: (detail: ProjectTeamTaskDetail, project: QuickTaskProject) => void;
}) {
  const createTask = useCreateTask();
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<QuickTaskAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    const result = await createTask(project.environmentId, {
      projectId: project.projectId,
      title: taskTitle,
      context,
      startPlanning: true,
      ...(uploaded.length > 0 ? { attachments: uploaded } : {}),
    });
    setSending(false);
    if (!AsyncResult.isSuccess(result)) {
      setError("Could not create the task. Try again.");
      return;
    }
    reset();
    props.onCreated(result.value, project);
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

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup
        className="max-w-xl"
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
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Dump the context. The project manager starts planning it right away.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3" onKeyDown={handleKeyDown}>
            {projects.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No project has a project manager yet. Set one up in a project first.
              </p>
            ) : (
              <Select
                value={project === null ? null : quickTaskProjectKey(project)}
                onValueChange={(value) => {
                  if (typeof value === "string") setProjectKey(value);
                }}
              >
                <SelectTrigger size="sm" aria-label="Project" className="w-fit min-w-40">
                  <SelectValue>{project?.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((candidate) => (
                    <SelectItem
                      key={quickTaskProjectKey(candidate)}
                      value={quickTaskProjectKey(candidate)}
                      label={candidate.name}
                    >
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            <Input
              aria-label="Task title"
              placeholder="Title (optional, first line is used)"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              autoFocus
              aria-label="Task context"
              placeholder="What needs doing? Paste logs, links, screenshots, files…"
              value={context}
              onChange={(event) => setContext(event.target.value)}
              onPaste={handlePaste}
              className={dragging ? "min-h-40 border-primary" : "min-h-40"}
            />
            {attachments.length > 0 ? (
              <ul aria-label="Attachments" className="flex flex-wrap gap-2">
                {attachments.map((attachment) => {
                  const upload = uploads[attachment.id];
                  return (
                    <li
                      key={attachment.id}
                      className="flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-xs"
                    >
                      {attachment.type === "image" ? (
                        <img
                          src={attachment.previewUrl}
                          alt=""
                          className="size-6 rounded object-cover"
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
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || project === null}
          >
            <PaperclipIcon />
            Attach
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-label="Attach files"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void addFiles(files);
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={sending || project === null}
          >
            {sending ? "Creating…" : `Create task`}
            {sending ? null : <span className="opacity-60 max-md:hidden">{submitHint}</span>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
