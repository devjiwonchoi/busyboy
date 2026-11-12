import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { ShieldAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

export type OperationPermissionItem = Extract<
  OrchestrationV2TurnItem,
  { type: "operation_permission" }
>;

const STATUS_LABELS: Readonly<Record<OperationPermissionItem["permissionStatus"], string>> = {
  pending: "승인 대기 중",
  approved: "승인됨 · 실행 준비 중",
  declined: "거절됨 · 실행하지 않음",
  cancelled: "취소됨 · 실행하지 않음",
  expired: "만료됨 · 실행하지 않음",
  consumed: "승인 사용됨 · 실행 중",
  succeeded: "실행 완료",
  failed: "실행 실패",
};

export function OperationPermissionCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: OperationPermissionItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerOperationPermission, {
    label: "answer operation permission",
    reportFailure: false,
    reportDefect: false,
  });
  const expiresAt = Date.parse(item.expiresAt);
  const [expired, setExpired] = useState(
    () => !Number.isFinite(expiresAt) || expiresAt <= Date.now(),
  );
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const remaining = expiresAt - Date.now();
    setExpired(!Number.isFinite(remaining) || remaining <= 0);
    if (remaining <= 0 || !Number.isFinite(remaining)) {
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const pending = item.permissionStatus === "pending" && decision === null;
  const effectiveStatus =
    item.permissionStatus !== "pending"
      ? STATUS_LABELS[item.permissionStatus]
      : decision === "allow"
        ? STATUS_LABELS.approved
        : decision === "deny"
          ? STATUS_LABELS.declined
          : expired
            ? STATUS_LABELS.expired
            : STATUS_LABELS.pending;

  const respond = async (next: "allow" | "deny") => {
    if (
      inFlight.current ||
      !pending ||
      expiresAt <= Date.now() ||
      !Number.isFinite(expiresAt) ||
      props.visibility !== "local"
    ) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: { threadId: item.threadId, turnItemId: item.id, decision: next },
    }).catch((error: unknown) => {
      setBusy(false);
      throw error;
    });
    setBusy(false);
    if (result._tag === "Success") {
      setDecision(next);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError("응답을 보내지 못했습니다. 다시 시도해 주세요.");
    }
    inFlight.current = false;
  };

  if (props.visibility !== "local" || !pending || expired) {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<ShieldAlertIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.summary} ·{" "}
            {props.visibility !== "local" && item.permissionStatus === "pending"
              ? "원래 스레드에서 사용자 승인을 기다립니다"
              : effectiveStatus}
          </>
        }
      />
    );
  }

  return (
    <section
      data-v2-item-type={item.type}
      aria-label="작업 실행 승인"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex items-start gap-2">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-foreground">이 작업을 한 번 허용할까요?</p>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{item.summary}</p>
          <p className="break-words text-xs text-muted-foreground">
            대상: {item.targetDescription}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {item.reason}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        승인 범위: 이 작업 한 번 ·{" "}
        <time dateTime={item.expiresAt}>{new Date(expiresAt).toLocaleTimeString("ko-KR")}</time>
        까지 유효
      </p>
      <p className="text-xs text-muted-foreground">
        사용자 직접 승인만 인정합니다. AFK나 다른 에이전트가 대신 승인할 수 없습니다. 권한 모드는
        바뀌지 않습니다.
      </p>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void respond("allow")}>
          이번 한 번 허용
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void respond("deny")}>
          거절
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {busy ? "응답을 보내는 중입니다." : "승인 전에는 실행하지 않습니다."}
      </p>
    </section>
  );
}
