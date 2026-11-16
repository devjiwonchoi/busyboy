import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import type { Companion } from '@/server/companions'

/** The companion's art, or the user's own picture when they set one. Decorative: the name is always shown next to it. */
export function CompanionAvatar({
  companion,
  imageUrl,
  className,
}: {
  companion: Companion
  imageUrl?: string
  className?: string
}) {
  return (
    <Avatar aria-hidden className={cn('size-10 text-xl', className)}>
      {imageUrl && <AvatarImage src={imageUrl} alt="" />}
      <AvatarFallback>{companion.emoji}</AvatarFallback>
    </Avatar>
  )
}
