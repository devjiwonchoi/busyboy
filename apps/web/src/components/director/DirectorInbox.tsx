import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatTaskKey } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useDirectorInbox } from "~/state/director";
import { useProjects } from "~/state/entities";
import { pendingActionItems } from "~/state/projectTeam.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import { DecisionCard } from "../chat/DecisionCard";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "../ui/dialog";
import type { DirectorInboxGroup } from "./directorInbox.logic";

/** Resolve names by both environment and project: IDs can repeat across servers. */
export function useDirectorInboxTitles() {
  const projects = useProjects();
  return (group: DirectorInboxGroup) =>
    group.isDirector
      ? group.pmName
      : (projects.find(
          (project) =>
            project.environmentId === group.environmentId && project.id === group.projectId,
        )?.title ?? "프로젝트");
}

export function DirectorInbox(props: { highlightCardId: string | null; showEmpty: boolean }) {
  const { groups, total } = useDirectorInbox();
  const titleOf = useDirectorInboxTitles();
  const navigate = useNavigate();
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const section = useRef<HTMLElement>(null);

  // The dialog mounts the same cards; reveal only within its own list.
  useEffect(() => {
    if (!props.highlightCardId) {
      return;
    }
    const element = section.current?.querySelector<HTMLElement>(
      `[data-decision-card="${CSS.escape(props.highlightCardId)}"]`,
    );
    if (!element) {
      return;
    }
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    element.dataset.decisionCardHighlighted = "true";
    const timer = window.setTimeout(
      () => element.removeAttribute("data-decision-card-highlighted"),
      1800,
    );
    return () => {
      window.clearTimeout(timer);
      element.removeAttribute("data-decision-card-highlighted");
    };
  }, [props.highlightCardId]);

  if (total === 0) {
    return props.showEmpty ? (
      <p className="text-muted-foreground text-sm">기다리는 일이 없어요</p>
    ) : null;
  }

  return (
    <section ref={section} data-director-inbox className="flex min-w-0 flex-col gap-4">
      <h2 className="font-semibold text-base">나를 기다리는 일 {total}</h2>
      {groups.map((group) => {
        // Korean elapsed labels avoid the shared formatter's English suffixes.
        const minutes =
          group.oldestAt === null
            ? null
            : Math.max(0, Math.floor((now - Date.parse(group.oldestAt)) / 60_000));
        const elapsed =
          minutes === null
            ? null
            : minutes < 1
              ? "방금 올라옴"
              : minutes < 60
                ? `${minutes}분째 기다림`
                : minutes < 1440
                  ? `${Math.floor(minutes / 60)}시간째 기다림`
                  : `${Math.floor(minutes / 1440)}일째 기다림`;
        return (
          <div
            key={`${group.environmentId}:${group.projectId}`}
            data-director-inbox-project={group.projectId}
            className="flex min-w-0 flex-col gap-3"
          >
            <h3 className="break-words font-medium text-sm">
              {titleOf(group)} · {group.pmName} · {group.total}개
              {elapsed === null ? "" : ` · ${elapsed}`}
            </h3>
            {group.cards.map((card) => (
              <div key={card.item.id} className="min-w-0">
                <p className="mb-1 break-words text-muted-foreground text-xs">
                  {card.taskNumber > 0 ? formatTaskKey(group.taskKeyPrefix, card.taskNumber) : ""}{" "}
                  {card.taskTitle}
                </p>
                <DecisionCard
                  card={card}
                  environmentId={group.environmentId}
                  threadRef={scopeThreadRef(group.environmentId, group.pmThreadId)}
                  cwd={undefined}
                />
              </div>
            ))}
            {group.waitingThreads.map((thread) => (
              <div
                key={thread.threadId}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm"
              >
                <span className="min-w-0 flex-1 break-words">
                  {pendingActionItems({ cards: [], waitingThreads: [thread] })[0]?.label}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-3 py-2 hover:bg-muted"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(group.environmentId, thread.threadId),
                      ),
                    })
                  }
                >
                  열기
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

export function DirectorInboxDialog(props: { cardId: string | null; onClose: () => void }) {
  return (
    <Dialog
      open={props.cardId !== null}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogPopup
        showCloseButton={false}
        className="flex max-h-[85dvh] w-full min-w-0 flex-col overflow-y-auto p-4 sm:max-w-3xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <DialogTitle className="flex-1">나를 기다리는 일</DialogTitle>
          <DialogClose className="rounded-md px-3 py-2 text-sm hover:bg-muted">닫기</DialogClose>
        </div>
        <DirectorInbox highlightCardId={props.cardId} showEmpty />
      </DialogPopup>
    </Dialog>
  );
}
