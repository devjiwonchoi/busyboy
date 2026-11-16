'use client'

import { mergePullRequestsAction } from '@/app/(main)/director-actions'
import { cardGroupLabel, type PrCard, type PullRequestCheck } from '@/server/cards/model'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import type { CardViewProps } from '../card-view-props'
import { CardActionError, CardTrailingActions, useCardActions } from '../card-actions'
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from '../card-shell'

const CHECK_DOT: Record<Exclude<PullRequestCheck, 'none'>, string> = {
  passing: 'bg-success',
  failing: 'bg-destructive',
  pending: 'bg-warning',
}

const CHECK_LABEL: Record<Exclude<PullRequestCheck, 'none'>, string> = {
  passing: 'Checks passing',
  failing: 'Checks failing',
  pending: 'Checks pending',
}

/**
 * One row per pull request, in stack order. Open leaves the merge for the
 * button, which runs only on a click.
 */
export function PrCardView({ card }: CardViewProps<PrCard>) {
  const { pending, replying, run } = useCardActions()
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader title={card.title} />
      <CardShellBody>
        <ItemGroup className="gap-1">
          {card.pulls.map((pull) => (
            <Item key={pull.number} variant="default" size="xs" role="listitem" className="px-0">
              <ItemMedia>
                {pull.check !== 'none' && (
                  <>
                    <span data-check={pull.check} className={cn('size-2 rounded-full', CHECK_DOT[pull.check])} aria-hidden />
                    <span className="sr-only">{CHECK_LABEL[pull.check]}</span>
                  </>
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  #{pull.number} {pull.title}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                {pull.review && <span className="text-muted-foreground">{pull.review}</span>}
                <a
                  href={pull.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open #${pull.number} ${pull.title}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  Open
                </a>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
        {card.note && <p className="text-muted-foreground">{card.note}</p>}
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <Button
          type="button"
          size="sm"
          disabled={pending || card.pulls.length === 0}
          onClick={() => run(() => mergePullRequestsAction(card.id), 'The pull requests could not be merged. Try again.')}
        >
          Merge in order
        </Button>
        <CardTrailingActions />
      </CardShellActions>
    </CardShell>
  )
}
