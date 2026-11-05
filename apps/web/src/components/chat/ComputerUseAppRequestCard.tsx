import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  COMPUTER_USE_NO_ALWAYS_ALLOW_BUNDLE_IDS,
  type ComputerUseAppRequestChoice,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { AppWindowIcon, CheckIcon, LockIcon, MinusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

export type ComputerUseAppRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "computer_use_app_request" }
>;

export const COMPUTER_USE_APP_REQUEST_NOTE =
  "It can see this app's windows and click, type, and choose menu items in it. Content in the app could try to mislead the agent.";

const ANSWERED_LABELS: Record<
  Exclude<ComputerUseAppRequestItem["appRequestStatus"], "pending">,
  string
> = {
  allow_once: "Allowed for this turn",
  allow_thread: "Allowed for this thread",
  always: "Always allowed",
  deny: "Denied",
  cancelled: "Request ended",
};

const failureMessage = (failure: unknown) =>
  typeof failure === "object" &&
  failure !== null &&
  "_tag" in failure &&
  (failure._tag === "ComputerUseAppRequestError" ||
    failure._tag === "EnvironmentAuthorizationError") &&
  "message" in failure &&
  typeof failure.message === "string" &&
  failure.message.trim().length > 0
    ? failure.message
    : "Could not answer the request. Try again.";

export function ComputerUseAppRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ComputerUseAppRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  if (item.appRequestStatus !== "pending" || props.visibility !== "local") {
    const pendingElsewhere = item.appRequestStatus === "pending";
    const Icon = pendingElsewhere
      ? LockIcon
      : item.appRequestStatus === "deny" || item.appRequestStatus === "cancelled"
        ? MinusIcon
        : CheckIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.appName} ·{" "}
            {pendingElsewhere
              ? "Waiting for an answer in the original thread"
              : ANSWERED_LABELS[item.appRequestStatus as keyof typeof ANSWERED_LABELS]}
          </>
        }
      />
    );
  }
  return <PendingComputerUseAppRequest environmentId={props.environmentId} item={item} />;
}

function PendingComputerUseAppRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ComputerUseAppRequestItem;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerComputerUseAppRequest, {
    label: "answer computer-use app request",
    reportFailure: false,
    reportDefect: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const choose = async (choice: ComputerUseAppRequestChoice) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: { threadId: item.threadId, turnItemId: item.id, choice },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <ComputerUseAppRequestPrompt
      item={item}
      disabled={submitting}
      error={error}
      onChoose={(choice) => void choose(choice)}
    />
  );
}

/** The card's body, kept free of server state so it can be tested on its own. */
export function ComputerUseAppRequestPrompt(props: {
  readonly item: Pick<ComputerUseAppRequestItem, "type" | "appName" | "bundleId" | "allowAlways">;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onChoose: (choice: ComputerUseAppRequestChoice) => void;
}) {
  const { item } = props;
  // The server never offers it for System Settings; the card checks too.
  const offerAlways =
    item.allowAlways && !COMPUTER_USE_NO_ALWAYS_ALLOW_BUNDLE_IDS.includes(item.bundleId);
  return (
    <div
      data-v2-item-type={item.type}
      role="group"
      aria-label={`Let the agent use ${item.appName}?`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <AppWindowIcon className="mt-0.5 size-5 shrink-0 text-icon-muted" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-foreground">Let the agent use {item.appName}?</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{item.bundleId}</p>
          <p className="text-sm text-muted-foreground">{COMPUTER_USE_APP_REQUEST_NOTE}</p>
        </div>
      </div>
      {props.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {props.error}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={props.disabled}
          onClick={() => props.onChoose("deny")}
        >
          Deny
        </Button>
        {offerAlways ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={() => props.onChoose("always")}
          >
            Always allow
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={props.disabled}
          onClick={() => props.onChoose("allow_thread")}
        >
          Allow for this thread
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={props.disabled}
          onClick={() => props.onChoose("allow_once")}
        >
          Allow once
        </Button>
      </div>
    </div>
  );
}
