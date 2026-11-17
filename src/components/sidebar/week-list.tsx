'use client'

import { useEffect, useId, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

type WeekTask = { project: string; taskId: string; title: string; met: number; agreed: number }

type Week = { start: string; label: string; met: number; agreed: number; tasks: WeekTask[] }

type Snapshot = { weeks: Week[] } | { error: string }

/**
 * One compact week at a time: the share of agreed end-state items met, and
 * the tasks that make it up. A plain bar rather than a chart component — the
 * library has no mark for a single proportion.
 */
export function WeekList() {
  const headingId = useId()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const response = await fetch('/api/achievement', { cache: 'no-store' })
        if (!stopped && response.ok) setSnapshot((await response.json()) as Snapshot)
      } catch {
        // The next poll tries again.
      }
    }
    void load()
    const timer = setInterval(() => void load(), 2_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  const weeks = snapshot && 'weeks' in snapshot ? snapshot.weeks : []
  const error = snapshot && 'error' in snapshot ? snapshot.error : null

  return (
    <section role="region" aria-labelledby={headingId} data-loaded={snapshot !== null} className="flex flex-col gap-3 p-3">
      <h2 id={headingId} className="px-1 text-sm font-medium">
        End state achievement
      </h2>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {snapshot && !error && weeks.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing on main yet</EmptyTitle>
            <EmptyDescription>Agreed end states show up here once their records are on main.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {weeks.map((week) => {
        const share = week.agreed === 0 ? 0 : Math.round((week.met / week.agreed) * 100)
        return (
          <div
            key={week.start}
            role="group"
            aria-label={`${week.label}, End state achievement ${week.met}/${week.agreed}`}
            className="rounded-lg bg-card px-3 py-2 ring-1 ring-foreground/10"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm">{week.label}</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {week.met}/{week.agreed}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10" aria-hidden>
              <div className="h-full rounded-full bg-status-done" style={{ width: `${share}%` }} />
            </div>
            <ul className="mt-2 space-y-1">
              {week.tasks.map((task) => (
                <li
                  key={`${task.project}/${task.taskId}`}
                  aria-label={`${task.title}, End state achievement ${task.met}/${task.agreed}`}
                  className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground"
                >
                  <span className="min-w-0 truncate text-foreground">{task.title}</span>
                  <span className="shrink-0 tabular-nums">
                    {task.met}/{task.agreed}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
