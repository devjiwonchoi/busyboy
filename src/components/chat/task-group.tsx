'use client'

import { Archive, ArchiveRestore, MessageSquare, Square } from 'lucide-react'
import { useState } from 'react'
import { archiveTaskAction, restoreTaskAction, stopTaskAction } from '@/app/(main)/director-actions'
import { useTaskSelection } from '@/components/shell/shell-state'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'
import { Toggle } from '@/components/ui/toggle'
import type { TaskStatus, TaskView } from '@/server/tasks'

// Status colors follow the app's scheme (amber needs you, blue running, gray
// idle, red stopped). Badge has no amber or blue variant, so those two add
// their color through className on the outline variant.
const STATUS: Record<TaskStatus, { label: string; variant: 'outline' | 'destructive'; className?: string }> = {
  running: { label: 'Running', variant: 'outline', className: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  'needs-you': {
    label: 'Needs you',
    variant: 'outline',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  idle: { label: 'Idle', variant: 'outline' },
  stopped: { label: 'Stopped', variant: 'destructive' },
}

const DONE = { label: 'Done', variant: 'outline' as const, className: undefined }
const ARCHIVED = { label: 'Archived', variant: 'outline' as const, className: 'text-muted-foreground' }

/**
 * The tasks the Director created in one turn, one `project · task` line each, with Stop while its agent runs.
 * Pressing a line selects that task for the terminal; pressing it again clears it. Message points the
 * composer at the task's agent for one message; pressing it again points it back at the Director.
 * A task that is not working can be archived, and an archived one restored.
 */
export function TaskGroup({
  taskIds,
  tasks,
  messaging,
  onMessage,
}: {
  taskIds: string[]
  tasks: Map<string, TaskView>
  /** The task the composer's next message goes to, if any. */
  messaging: string | null
  onMessage: (taskId: string | null) => void
}) {
  const { selectedTask, toggleTask } = useTaskSelection()
  const [error, setError] = useState<string | null>(null)
  // Said once after an archive that could not remove the worktree.
  const [notice, setNotice] = useState<string | null>(null)
  const act = (action: Promise<{ error?: string; worktreeKept?: boolean }>, failure: string) => {
    setError(null)
    setNotice(null)
    action.then(
      (result) => {
        if (result.error) setError(result.error)
        else if (result.worktreeKept) setNotice('Archived. Its worktree was kept because it has changes that are not committed.')
      },
      () => setError(failure),
    )
  }
  return (
    <Message>
      <MessageContent>
        <Bubble variant="outline" role="group" aria-label="Tasks" className="w-full max-w-[80%]">
          <BubbleContent className="w-full">
            <ul className="space-y-1">
              {taskIds.map((id) => {
                const task = tasks.get(id)
                // A subagent that finished its turn has done its one action.
                const done = Boolean(task?.subagent && task.status === 'idle')
                const status = task ? (task.archived ? ARCHIVED : done ? DONE : STATUS[task.status]) : undefined
                const working = task?.status === 'running' || task?.status === 'needs-you'
                return (
                  <li key={id} aria-label={task ? `${task.project} · ${task.title}` : id} className="space-y-1">
                    <div className="flex items-center gap-3">
                      {task?.subagent ? (
                        // A subagent has no worktree, so there is nothing to select for the terminal.
                        <span className="min-w-0 flex-1 truncate text-sm">
                          <span className="text-muted-foreground">{task.project} · </span>
                          <span>{task.title}</span>
                        </span>
                      ) : (
                        <Toggle
                          size="lg"
                          aria-label={task ? `Select ${task.project} · ${task.title}` : id}
                          // An archived task usually has no worktree to open a terminal in.
                          disabled={!task || task.archived}
                          pressed={selectedTask?.id === id}
                          onPressedChange={() => task && toggleTask({ id, project: task.project, title: task.title })}
                          // A full-width line of text, not a square icon toggle.
                          className="-mx-2.5 min-w-0 flex-1 justify-start text-sm font-normal"
                        >
                          <span className="min-w-0 truncate">
                            <span className="text-muted-foreground">{task?.project ?? '…'} · </span>
                            <span>{task?.title ?? id}</span>
                          </span>
                        </Toggle>
                      )}
                      {task?.subagent && <Badge variant="secondary">Subagent</Badge>}
                      {status && (
                        <Badge variant={status.variant} className={status.className} data-status={task?.status}>
                          {status.label}
                        </Badge>
                      )}
                      {/* A subagent does one action, and a task that waits on a card is answered on that card. */}
                      {task && !task.subagent && !task.archived && task.status !== 'needs-you' && (
                        <Toggle
                          size="sm"
                          aria-label={`Message ${task.project} · ${task.title}`}
                          pressed={messaging === id}
                          onPressedChange={(pressed) => onMessage(pressed ? id : null)}
                        >
                          <MessageSquare />
                        </Toggle>
                      )}
                      {task && !task.archived && !working && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Archive ${task.project} · ${task.title}`}
                          onClick={() => act(archiveTaskAction(task.id), 'The task could not be archived. Try again.')}
                        >
                          <Archive />
                        </Button>
                      )}
                      {task?.archived && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Restore ${task.project} · ${task.title}`}
                          onClick={() => act(restoreTaskAction(task.id), 'The task could not be restored. Try again.')}
                        >
                          <ArchiveRestore />
                        </Button>
                      )}
                      {task && !task.archived && task.status !== 'stopped' && !done && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Stop ${task.project} · ${task.title}`}
                          onClick={() => {
                            setError(null)
                            stopTaskAction(task.id).catch(() => setError('The task could not be stopped. Try again.'))
                          }}
                        >
                          <Square />
                        </Button>
                      )}
                    </div>
                    {/* A subagent's result is its last reply; a task reports through its records instead. */}
                    {task?.reply && (
                      <p aria-label="Result" className="text-muted-foreground text-sm whitespace-pre-wrap">
                        {task.reply}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
            {notice && (
              <Alert className="mt-2">
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive" className="mt-2">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}
