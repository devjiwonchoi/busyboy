'use client'

export type ContextUsage = {
  usedTokens: number
  contextWindow?: number
}

function formatTokens(value: number) {
  if (value < 1000) return String(value)
  const scaled = value / 1000
  const text = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)
  return `${text.replace(/\.0$/, '')}k`
}

/** How full the active session's context is, once the harness has reported it. */
export function ContextMeter({ usage }: { usage: ContextUsage | null }) {
  if (!usage || usage.usedTokens <= 0) return null
  const max = usage.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : undefined
  const pct = max ? Math.min(100, (usage.usedTokens / max) * 100) : 100
  const label = max ? `${formatTokens(usage.usedTokens)} / ${formatTokens(max)}` : `${formatTokens(usage.usedTokens)} tokens`
  return (
    <div
      role="meter"
      aria-label="Context usage"
      aria-valuemin={0}
      aria-valuenow={usage.usedTokens}
      aria-valuemax={max ?? usage.usedTokens}
      aria-valuetext={label}
      data-slot="context-meter"
      className="text-muted-foreground mb-2 flex items-center gap-2 text-xs"
    >
      <div className="bg-muted h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
        <div className="bg-foreground/70 h-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 tabular-nums">{label}</span>
    </div>
  )
}
