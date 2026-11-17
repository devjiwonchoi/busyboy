import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import type { Companion } from '@/server/companions'

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
    <Avatar aria-hidden data-emoji={companion.emoji} className={cn('size-10 text-xl', className)}>
      {imageUrl && <AvatarImage src={imageUrl} alt="" />}
      <AvatarFallback className={companion.tone}>{companion.emoji}</AvatarFallback>
    </Avatar>
  )
}
