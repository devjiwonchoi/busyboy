import {
  computerUseApprovalAnswerInput,
  computerUseApprovalDisplay,
  computerUseApprovalFailureMessage,
  type ComputerUseApprovalItem,
} from "@t3tools/client-runtime/computer-use-approval";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerUseApprovalDecision,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { CheckIcon, MinusIcon, MonitorIcon } from "lucide-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

export function ComputerUseApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ComputerUseApprovalItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = computerUseApprovalDisplay(item, props.visibility);
  if (display.kind !== "pending") {
    const Icon =
      display.kind === "pending-elsewhere" ? MonitorIcon : display.allowed ? CheckIcon : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            Use {item.appName} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingComputerUseApproval environmentId={props.environmentId} item={item} />;
}

function PendingComputerUseApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ComputerUseApprovalItem;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerComputerUseApproval, {
    label: "answer computer-use approval",
    reportFailure: false,
    reportDefect: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two quick clicks can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (decision: ComputerUseApprovalDecision) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: computerUseApprovalAnswerInput(item, decision),
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setError(computerUseApprovalFailureMessage(squashAtomCommandFailure(result)));
  };

  return (
    <section
      data-v2-item-type={item.type}
      aria-label={`Allow computer use with ${item.appName}?`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <MonitorIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
          Allow the agent to use {item.appName}?
        </p>
        <p className="text-sm text-muted-foreground">
          It can read {item.appName}'s windows and click and type in them while you keep working.
        </p>
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" disabled={submitting} onClick={() => void send("allow_once")}>
          Allow this turn
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={submitting}
          onClick={() => void send("allow_thread")}
        >
          Allow in this thread
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={submitting}
          onClick={() => void send("allow_always")}
        >
          Always allow
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          className="ms-auto"
          disabled={submitting}
          onClick={() => void send("deny")}
        >
          Don't allow
        </Button>
      </div>
    </section>
  );
}
