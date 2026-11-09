import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";

import { newMessageId } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { PmAvatar } from "../PmAvatar";
import { toastManager } from "../ui/toast";
import type { DirectorChat } from "./useDirectorChat";

/**
 * The top of All projects: one line to message the Director about work across
 * projects. Sending goes straight to the Director's chat and opens it.
 */
export function DirectorCard(props: { director: DirectorChat }) {
  const { director } = props;
  const { summary } = director.entry;
  const canOperate = useEnvironmentScope(
    director.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputId = useId();
  const thread = director.thread;
  const canSend = canOperate && thread !== null && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend || thread === null) return;
    setSending(true);
    const result = await startTurn({
      environmentId: director.threadRef.environmentId,
      input: {
        threadId: director.threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: text.trim(), attachments: [] },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        dispatchMode: "auto",
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Director에게 보내지 못했어요",
        description: error instanceof Error ? error.message : "다시 시도해 주세요.",
      });
      return;
    }
    setText("");
    void director.open();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <section data-director-card className="flex flex-col gap-3">
      <form
        aria-label={summary.persona.name}
        onSubmit={onSubmit}
        className="flex items-center gap-2 rounded-xl border border-border bg-card py-1.5 pr-1.5 pl-2"
      >
        <button
          type="button"
          onClick={() => void director.open()}
          aria-label={`${summary.persona.name} 채팅 열기`}
          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PmAvatar persona={summary.persona} status={director.status} size="sm" />
        </button>
        <label htmlFor={inputId} className="sr-only">
          {summary.persona.name}에게 메시지
        </label>
        <textarea
          id={inputId}
          rows={1}
          value={text}
          disabled={!canOperate}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`${summary.persona.name}에게 말하기… (여러 프로젝트에 걸친 일)`}
          className="field-sizing-content max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground disabled:opacity-64 sm:text-sm"
        />
        <button
          type="submit"
          aria-label="Director에게 보내기"
          disabled={!canSend}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <ArrowUpIcon aria-hidden className="size-4" />
        </button>
      </form>
    </section>
  );
}
