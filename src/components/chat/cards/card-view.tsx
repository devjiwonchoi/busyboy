'use client'

import type { ComponentType } from 'react'
import type { TaskCard } from '@/server/cards/model'
import { ChoiceCard } from './choice-card'
import type { CardViewProps } from './card-view-props'
import { DoneCardView } from './kinds/done-card'
import { PlanCardView } from './kinds/plan-card'
import { PrCardView } from './kinds/pr-card'
import { ProgressCardView } from './kinds/progress-card'

type KindView<T extends TaskCard> = ComponentType<CardViewProps<T>>

// Each kind has its own module. A follow-up replaces that module; this map stays.
const views: { [K in TaskCard['kind']]: KindView<Extract<TaskCard, { kind: K }>> } = {
  question: ChoiceCard,
  approval: ChoiceCard,
  plan: PlanCardView,
  progress: ProgressCardView,
  done: DoneCardView,
  pr: PrCardView,
}

export function TimelineCardView({ card }: CardViewProps) {
  const View = views[card.kind] as KindView<TaskCard>
  return <View card={card} />
}
