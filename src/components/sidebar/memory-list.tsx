'use client'

import { PencilIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'
import { forgetMemoryAction, saveMemoryAction } from '@/app/(main)/memory-actions'
import type { MemoryFact, MemoryScope } from '@/server/memory'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Textarea } from '@/components/ui/textarea'

const scopeName = (project: string | null) => (project === null ? 'Global' : project)

/** Every remembered fact by scope, live, with edit and delete. */
export function MemoryList() {
  const [scopes, setScopes] = useState<MemoryScope[] | null>(null)

  useEffect(() => {
    const source = new EventSource('/api/memory/events')
    source.onmessage = (message) => setScopes((JSON.parse(message.data) as { scopes: MemoryScope[] }).scopes)
    return () => source.close()
  }, [])

  const withFacts = scopes?.filter(({ facts }) => facts.length > 0) ?? []

  return (
    <div role="region" aria-label="Memory" data-loaded={scopes !== null} className="flex flex-col gap-4 p-3">
      {scopes !== null && withFacts.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing remembered yet</EmptyTitle>
            <EmptyDescription>Say “remember …” in the chat and it shows up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {withFacts.map(({ project, facts }) => (
        <section key={project ?? ''} aria-label={`${scopeName(project)} memory`} className="flex flex-col gap-2">
          <h3 className="px-1 text-xs font-medium text-muted-foreground">{scopeName(project)}</h3>
          <ItemGroup className="gap-2">
            {facts.map((fact) => (
              <FactItem key={fact.id} fact={fact} />
            ))}
          </ItemGroup>
        </section>
      ))}
    </div>
  )
}

function FactItem({ fact }: { fact: MemoryFact }) {
  const [editing, setEditing] = useState(false)
  if (editing) return <FactEditor fact={fact} onDone={() => setEditing(false)} />
  return (
    <Item variant="outline" size="sm" role="listitem" aria-label={fact.title}>
      <ItemContent>
        <ItemTitle>{fact.title}</ItemTitle>
        <ItemDescription className="line-clamp-none whitespace-pre-wrap">{fact.text}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${fact.title}`} onClick={() => setEditing(true)}>
          <PencilIcon />
        </Button>
        <ForgetButton fact={fact} />
      </ItemActions>
    </Item>
  )
}

function FactEditor({ fact, onDone }: { fact: MemoryFact; onDone: () => void }) {
  const [title, setTitle] = useState(fact.title)
  const [text, setText] = useState(fact.text)
  const [error, setError] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const save = () =>
    startSaving(async () => {
      // The id stays, so a new title edits this fact instead of adding another.
      const message = await saveMemoryAction(fact.project, fact.id, title, text).catch(() => 'The memory could not be saved.')
      if (message) setError(message)
      else onDone()
    })

  return (
    <Item variant="outline" size="sm" role="listitem" aria-label={`Editing ${fact.title}`}>
      <form
        className="w-full"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <FieldGroup className="gap-2">
          <Field>
            <FieldLabel htmlFor={`memory-title-${fact.id}`}>Title</FieldLabel>
            <Input id={`memory-title-${fact.id}`} value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field data-invalid={Boolean(error) || undefined}>
            <FieldLabel htmlFor={`memory-text-${fact.id}`}>Text</FieldLabel>
            <Textarea
              id={`memory-text-${fact.id}`}
              value={text}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => setText(event.target.value)}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              Save
            </Button>
          </div>
        </FieldGroup>
      </form>
    </Item>
  )
}

function ForgetButton({ fact }: { fact: MemoryFact }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forgetting, startForgetting] = useTransition()

  const forget = () =>
    startForgetting(async () => {
      const message = await forgetMemoryAction(fact.project, fact.id).catch(() => 'The memory could not be deleted.')
      if (message) setError(message)
      else setOpen(false)
    })

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Delete ${fact.title}`} />}>
        <Trash2Icon />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{fact.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The chat and new tasks stop seeing it. {error}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={forget} disabled={forgetting}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
