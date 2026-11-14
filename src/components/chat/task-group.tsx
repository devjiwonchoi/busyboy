'use client'

import { Square } from 'lucide-react'
import { useState } from 'react'
import { stopTaskAction } from '@/app/(main)/director-actions'
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

/**
 * The tasks the Director created in one turn, one `project · task` line each, with Stop while its agent runs.
 * Pressing a line selects that task for the terminal; pressing it again clears it.
 */
export function TaskGroup({ taskIds, tasks }: { taskIds: string[]; tasks: Map<string, TaskView> }) {
  const { selectedTask, toggleTask } = useTaskSelection()
  const [error, setError] = useState<string | null>(null)
  return (
    <Message>
      <MessageContent>
        <Bubble variant="outline" role="group" aria-label="Tasks" className="w-full max-w-[80%]">
          <BubbleContent className="w-full">
            <ul className="space-y-1">
              {taskIds.map((id) => {
                const task = tasks.get(id)
                const status = task ? STATUS[task.status] : undefined
                return (
                  <li
                    key={id}
                    aria-label={task ? `${task.project} · ${task.title}` : id}
                    className="flex items-center gap-3"
                  >
                    <Toggle
                      size="lg"
                      aria-label={task ? `Select ${task.project} · ${task.title}` : id}
                      disabled={!task}
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
                    {status && (
                      <Badge variant={status.variant} className={status.className} data-status={task?.status}>
                        {status.label}
                      </Badge>
                    )}
                    {task && task.status !== 'stopped' && (
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
                  </li>
                )
              })}
            </ul>
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
