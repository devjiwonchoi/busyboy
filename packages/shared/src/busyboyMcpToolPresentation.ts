export type BusyboyMcpToolLogo = "busyboy";

export interface BusyboyMcpToolPresentation {
  readonly displayName: string;
  readonly logo: BusyboyMcpToolLogo;
}

export type BusyboyMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "html-preview"
  | "html-render";

export interface BusyboyMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "busyboy" | "browser" | "pull-request";
  readonly summaryAction: BusyboyMcpToolSummaryAction;
}

function tool(
  labels: BusyboyMcpToolDefinition["labels"],
  summaryAction: BusyboyMcpToolSummaryAction,
  icon: BusyboyMcpToolDefinition["icon"] = "busyboy",
  displayName = `${labels[0]} ${labels[3]}`,
): BusyboyMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const BUSYBOY_MCP_SERVER_ALIASES = new Set(["busyboy"]);

const BUSYBOY_MCP_TOOLS: Readonly<Record<string, BusyboyMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "Busyboy threads"], "thread-create"),
  busyboy_thread_start: tool(["Start", "Starting", "Started", "a Busyboy thread"], "thread-create"),
  busyboy_thread_list: tool(["List", "Listing", "Listed", "Busyboy threads"], "thread-list"),
  busyboy_thread_read: tool(["Read", "Reading", "Read", "a Busyboy thread"], "thread-read"),
  busyboy_thread_send: tool(["Send", "Sending", "Sent", "to a Busyboy thread"], "thread-send"),
  busyboy_thread_wait: tool(["Wait", "Waiting", "Waited", "for a Busyboy thread"], "thread-wait"),
  busyboy_workflow_stop: tool(
    ["Stop", "Stopping", "Requested a stop for", "a workflow"],
    "workflow-stop",
  ),
  busyboy_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a Busyboy thread"],
    "thread-interrupt",
  ),
  busyboy_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  busyboy_worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  busyboy_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  busyboy_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  busyboy_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  busyboy_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  busyboy_queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  busyboy_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  busyboy_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  busyboy_pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  busyboy_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  busyboy_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  busyboy_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  busyboy_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  busyboy_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  busyboy_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  busyboy_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  busyboy_thread_organize: tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
  busyboy_thread_update: tool(["Update", "Updating", "Updated", "Busyboy thread metadata"], "thread-update"),
  busyboy_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  busyboy_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  busyboy_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  busyboy_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  busyboy_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  busyboy_thread_launch: tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
  busyboy_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  busyboy_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  busyboy_project_create: tool(["Register", "Registering", "Registered", "a project"], "project-create"),
  busyboy_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  busyboy_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  busyboy_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  busyboy_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  busyboy_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  busyboy_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
};

export const BUSYBOY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(BUSYBOY_MCP_TOOLS));

function normalizeBusyboyMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected Busyboy server prefixes its tools:
 * `mcp__busyboy__x` (Claude/Cursor), `busyboy.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveBusyboyMcpToolName(value: string): string | null {
  const label = normalizeBusyboyMcpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      BUSYBOY_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>busyboy)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
    label,
  );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  // Tool ids share the `busyboy_` prefix with the server name, so a bare tool
  // id must win before the server prefix is stripped.
  if (Object.hasOwn(BUSYBOY_MCP_TOOLS, label)) return label;
  const prefixed = /^(?:mcp[-_]{1,2})?busyboy(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(BUSYBOY_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 registers one server per thread, `busyboy-<thread>`, and joins
  // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
  // known tool name that ends the label.
  if (!/^busyboy-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(BUSYBOY_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveBusyboyMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveBusyboyMcpToolName(toolName);
  return name !== null && Object.hasOwn(BUSYBOY_MCP_TOOLS, name) ? name : null;
}

export function resolveBusyboyMcpToolDefinition(
  toolName: string | null | undefined,
): BusyboyMcpToolDefinition | null {
  const name = toolName == null ? null : resolveBusyboyMcpToolName(toolName);
  return name !== null && Object.hasOwn(BUSYBOY_MCP_TOOLS, name) ? BUSYBOY_MCP_TOOLS[name]! : null;
}

export function resolveBusyboyMcpToolPresentation(
  toolName: string | null | undefined,
): BusyboyMcpToolPresentation | null {
  const definition = resolveBusyboyMcpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "busyboy" };
}

export function resolveBusyboyMcpToolSummaryAction(
  toolName: string | null | undefined,
): BusyboyMcpToolSummaryAction | null {
  return resolveBusyboyMcpToolDefinition(toolName)?.summaryAction ?? null;
}
