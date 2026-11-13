import { cn } from '@/lib/utils'
import type { TaskStatus, TaskView } from '@/server/tasks'
import { Bubble } from './bubble'

// Status colors follow the app's scheme: amber needs you, blue running,
// gray waiting for a message, red stopped.
const STATUS: Record<TaskStatus, { label: string; dot: string }> = {
  running: { label: 'Running', dot: 'bg-blue-500' },
  'needs-you': { label: 'Needs you', dot: 'bg-amber-500' },
  idle: { label: 'Idle', dot: 'bg-zinc-400' },
  stopped: { label: 'Stopped', dot: 'bg-red-500' },
}

/** The tasks the master created in one turn, one `project · task` line each. */
export function TaskGroup({ taskIds, tasks }: { taskIds: string[]; tasks: Map<string, TaskView> }) {
  return (
    <Bubble role="group" aria-label="Tasks" className="py-2">
      <ul className="space-y-1">
        {taskIds.map((id) => {
          const task = tasks.get(id)
          const status = task ? STATUS[task.status] : undefined
          return (
            <li key={id} aria-label={task ? `${task.project} · ${task.title}` : id} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-foreground">{task?.project ?? '…'}</span>
                <span className="text-muted-foreground"> · </span>
                <span>{task?.title ?? id}</span>
              </span>
              {status && (
                <span data-status={task?.status} className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                  <span aria-hidden className={cn('size-1.5 rounded-full', status.dot)} />
                  {status.label}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </Bubble>
  )
}
