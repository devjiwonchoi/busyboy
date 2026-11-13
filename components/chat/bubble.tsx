import { cn } from '@/lib/utils'

/**
 * The one bubble shape of the chat. Master replies, task groups, and the
 * cards later todos add all use it, so they share surface, border, and radius.
 * `from="user"` only moves it to the right and tints the surface.
 */
export function Bubble({
  from = 'agent',
  className,
  ...props
}: React.ComponentProps<'div'> & { from?: 'user' | 'agent' }) {
  return (
    <div
      data-slot="bubble"
      data-from={from}
      className={cn(
        'max-w-[85%] min-w-0 rounded-xl border px-4 py-2.5 text-sm break-words',
        from === 'user' ? 'bg-secondary text-secondary-foreground self-end whitespace-pre-wrap' : 'bg-card text-card-foreground self-start',
        className,
      )}
      {...props}
    />
  )
}
