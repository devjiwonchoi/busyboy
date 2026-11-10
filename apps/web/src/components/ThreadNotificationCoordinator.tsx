import {
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ProjectTeamAttentionIndex } from "@t3tools/client-runtime/state/project-team";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProjectTeamAttentionSummary,
  ThreadId,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { useEnvironmentProjectTeamAttention } from "../state/projectTeam";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

export const OPEN_URL_MESSAGE = "busyboy:open-url";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    for (const [tag, entry] of pending.current) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.current.delete(tag);
    }
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    window.addEventListener("focus", clear);
    return () => {
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  // A tapped service worker notification asks this window to show its thread.
  const navigate = useNavigate();
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        typeof data !== "object" ||
        data === null ||
        !("type" in data) ||
        data.type !== OPEN_URL_MESSAGE ||
        !("url" in data) ||
        typeof data.url !== "string"
      ) {
        return;
      }
      const url = new URL(data.url);
      void navigate({ href: `${url.pathname}${url.search}${url.hash}` });
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [navigate]);

  if (mode === "off") return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly attention: string | null;
  readonly completion: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const snapshot =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value : null;
  const threads = snapshot?.threads ?? null;
  const projects = snapshot?.projects;
  const projectTeam = useEnvironmentProjectTeamAttention(environmentId);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, subagentRequest, attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Thread failed"
                : "Input needed";
      // A PM's finished turns and child questions surface as its Needs-you alert instead.
      if (
        projectTeam.byPmThreadId.has(thread.id) &&
        (title === "Thread completed" || title === "Input needed")
      ) {
        continue;
      }
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      showThreadNotification({
        environmentId,
        threadId: thread.id,
        title,
        body: thread.title,
        mode,
        viewing: activeEnvironmentId === environmentId && activeThreadId === thread.id,
        navigate,
        onNotification,
      });
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    mode,
    navigate,
    onNotification,
    projectTeam,
    threads,
  ]);

  // PM threads alert through their attention summary, never on the first snapshot.
  const previousTeam = useRef<ProjectTeamAttentionIndex | null>(null);
  useEffect(() => {
    const prior = previousTeam.current;
    previousTeam.current = projectTeam;
    if (prior === null || prior.byProjectId.size === 0) return;
    for (const summary of projectTeam.byProjectId.values()) {
      const before = prior.byProjectId.get(summary.projectId);
      if (!before) continue;
      const projectTitle =
        projects?.find((project) => project.id === summary.projectId)?.title ?? "Project";
      // Default persona names repeat across projects, so the title names the project too.
      const who = `${summary.persona.name} (${projectTitle})`;
      // Distinct tags keep a sitrep from replacing an unseen Needs-you notification.
      const notify = (title: string, kind: "attention" | "sitrep", body = projectTitle) =>
        showThreadNotification({
          environmentId,
          threadId: summary.pmThreadId,
          tagSuffix: kind,
          title,
          body,
          mode,
          viewing: activeEnvironmentId === environmentId && activeThreadId === summary.pmThreadId,
          navigate,
          onNotification,
        });
      // Leads keep running while the PM is off, so its blockers still need the user.
      if (summary.latestBatchId !== null && summary.latestBatchId !== before.latestBatchId) {
        notify(
          `${who} · Needs you: ${summary.openCount}`,
          "attention",
          newestOpenCardText(summary) ?? projectTitle,
        );
      }
      if (
        summary.enabled &&
        summary.settings.sitrepNotify &&
        summary.latestSitrepId !== null &&
        summary.latestSitrepId !== before.latestSitrepId
      ) {
        notify(`${who} · Sitrep`, "sitrep");
      }
    }
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    mode,
    navigate,
    onNotification,
    projectTeam,
    projects,
  ]);

  return null;
}

function showThreadNotification(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  tagSuffix?: string;
  title: string;
  body: string;
  mode: ClientSettings["notificationMode"];
  viewing: boolean;
  navigate: ReturnType<typeof useNavigate>;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const { environmentId, threadId, title, body, navigate } = input;
  const appFocused = document.visibilityState === "visible" && document.hasFocus();
  if (
    !hasDesktopNotifications(input.mode) ||
    (appFocused && input.viewing) ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  const tag = `${environmentId}:${threadId}${input.tagSuffix ? `:${input.tagSuffix}` : ""}`;
  try {
    const notification = new Notification(title, { body, tag, silent: true });
    // The badge clears on window focus, so only count notifications sent while away.
    if (!appFocused) {
      input.onNotification(environmentId, notification);
    }
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    });
  } catch {
    // Mobile browsers reject the constructor and only show notifications
    // through the service worker, which routes taps back through OPEN_URL_MESSAGE.
    void navigator.serviceWorker?.ready.then((registration) =>
      registration.showNotification(title, {
        body,
        tag,
        data: { url: `/${environmentId}/${threadId}` },
      }),
    );
  }
}

const NOTIFICATION_QUESTION_MAX_CHARS = 140;

/** "<task name>: <question>" for the newest open card, so the alert says what is waiting. */
function newestOpenCardText(summary: ProjectTeamAttentionSummary): string | null {
  const card = summary.decisionCards.findLast(
    (candidate) => candidate.item.answeredAt === null && candidate.item.supersededAt === null,
  );
  if (!card) return null;
  const question = card.item.question.replace(/\s+/g, " ").trim();
  const clipped =
    question.length > NOTIFICATION_QUESTION_MAX_CHARS
      ? `${question.slice(0, NOTIFICATION_QUESTION_MAX_CHARS)}…`
      : question;
  return `${card.taskTitle}: ${clipped}`;
}
