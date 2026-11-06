import { PlusIcon } from "lucide-react";

import { Button } from "../ui/button";
import { openQuickTask } from "./quickTaskStore";

/**
 * The phone way to add a task: a "+" in the chat header that opens the same
 * quick "New task" sheet as Cmd+N. Hidden from md up, where Cmd+N covers it.
 */
export function MobileNewTaskButton() {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="New task"
      className="shrink-0 md:hidden [-webkit-app-region:no-drag]"
      onClick={() => openQuickTask()}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
}
