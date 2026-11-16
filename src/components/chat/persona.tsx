import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/**
 * Who a chat's replies come from: the Director (the companion chosen in setup,
 * or BusyBoy itself before one is chosen) or a manager. `mark` is the emoji or
 * letter shown as the picture; without one no picture is shown.
 */
export type Persona = { name: string; mark?: string; imageUrl?: string }

/** A manager's mark: the first letter of its name. */
export function managerPersona(name: string): Persona {
  return { name, mark: [...name.trim()][0]?.toUpperCase() ?? 'M' }
}

/** Decorative: the name is always shown next to it. */
export function PersonaAvatar({ persona, className }: { persona: Persona; className?: string }) {
  return (
    <Avatar aria-hidden className={cn('size-8 text-base', className)}>
      {persona.imageUrl && <AvatarImage src={persona.imageUrl} alt="" />}
      <AvatarFallback>{persona.mark}</AvatarFallback>
    </Avatar>
  )
}
