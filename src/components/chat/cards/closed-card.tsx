import type { ChatEntry } from '@/server/director/chat'
import { Badge } from '@/components/ui/badge'
import { CardShell, CardShellBody, CardShellHeader } from './card-shell'

/** A card after it closed: what it asked and how it ended, in the same shell. */
export function ClosedCard({ entry }: { entry: Extract<ChatEntry, { kind: 'card' }> }) {
  return (
    <CardShell label={`Card from ${entry.project} · ${entry.taskTitle}`}>
      <CardShellHeader title={`${entry.project} · ${entry.taskTitle}`} />
      <CardShellBody>
        <p className="line-clamp-3">{entry.title}</p>
        <Badge variant="outline">{entry.outcome}</Badge>
      </CardShellBody>
    </CardShell>
  )
}
