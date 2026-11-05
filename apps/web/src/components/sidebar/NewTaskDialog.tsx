import type { EnvironmentId, ProjectId, ProjectTeamTaskDetail } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useCreateTask } from "~/state/projectTeam";
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
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export interface NewTaskTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
}

type NewTaskMode = "inbox" | "plan";

/**
 * Adds a task to a project: a title and whatever context the user dumps.
 * "Save to inbox" stores it without an agent; "Plan with an agent" asks the PM
 * to start a planner on it.
 */
export function NewTaskDialog(props: {
  target: NewTaskTarget | null;
  onClose: () => void;
  onCreated: (detail: ProjectTeamTaskDetail) => void;
}) {
  const createTask = useCreateTask();
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [mode, setMode] = useState<NewTaskMode>("plan");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { target } = props;

  const close = () => {
    if (sending) return;
    setTitle("");
    setContext("");
    setError(null);
    props.onClose();
  };

  const submit = () => {
    if (target === null || sending) return;
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setError("Give the task a title.");
      return;
    }
    setSending(true);
    setError(null);
    void createTask(target.environmentId, {
      projectId: target.projectId,
      title: trimmed,
      context,
      startPlanning: mode === "plan",
    }).then((result) => {
      setSending(false);
      if (!AsyncResult.isSuccess(result)) {
        setError("Could not create the task. Try again.");
        return;
      }
      setTitle("");
      setContext("");
      props.onCreated(result.value);
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>{target?.projectName ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3" onKeyDown={handleKeyDown}>
            <Input
              autoFocus
              aria-label="Task title"
              placeholder="Task title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Textarea
              aria-label="Context"
              placeholder="Dump the context: logs, links, what you noticed, anything."
              value={context}
              onChange={(event) => setContext(event.target.value)}
              className="min-h-32"
            />
            <ToggleGroup
              aria-label="What happens next"
              value={[mode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "inbox" || next === "plan") setMode(next);
              }}
              variant="outline"
              size="sm"
            >
              <Toggle value="inbox">Save to inbox</Toggle>
              <Toggle value="plan">Plan with an agent</Toggle>
            </ToggleGroup>
            <p className="text-muted-foreground text-xs">
              {mode === "plan"
                ? "The PM starts a planner that researches and writes the plan into the task."
                : "Saved without an agent. Ask the PM to plan it whenever you are ready."}
            </p>
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={close} disabled={sending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={sending}>
            {sending ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
