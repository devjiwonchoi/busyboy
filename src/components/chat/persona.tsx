import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/**
 * Who a chat's replies come from: the Director (the companion chosen in setup,
 * or BusyBoy itself before one is chosen) or a manager. `mark` is the emoji
 * shown as the picture; without one no picture is shown. `tone` is the circle
 * behind that emoji.
 */
export type Persona = { name: string; mark?: string; imageUrl?: string; tone?: string }

/** Full class strings so Tailwind can see them. */
const MANAGER_EMOJIS = ['🐝', '🌿', '✏️', '🌙', '🍋', '🎀', '⚡️', '🍀', '🌊', '🔥']
const MANAGER_TONES = [
  'bg-violet-500/20',
  'bg-teal-500/20',
  'bg-orange-500/20',
  'bg-sky-500/20',
  'bg-amber-500/20',
  'bg-rose-500/20',
]

function hashName(name: string) {
  let hash = 0
  for (const char of name) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0
  return hash
}

/** A manager's picture: the same emoji and color every time for a given name. */
export function managerPersona(name: string): Persona {
  const hash = hashName(name.trim() || 'Manager')
  return { name, mark: MANAGER_EMOJIS[hash % MANAGER_EMOJIS.length], tone: MANAGER_TONES[hash % MANAGER_TONES.length] }
}

/** Decorative: the name is always shown next to it. */
export function PersonaAvatar({ persona, className }: { persona: Persona; className?: string }) {
  return (
    <Avatar aria-hidden data-emoji={persona.mark} className={cn('size-8 text-base', className)}>
      {persona.imageUrl && <AvatarImage src={persona.imageUrl} alt="" />}
      <AvatarFallback className={persona.tone}>{persona.mark}</AvatarFallback>
    </Avatar>
  )
}
