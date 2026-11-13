'use client'

import { useActionState } from 'react'
import { addProjectAction, type AddProjectResult } from '@/app/setup/actions'
import { Button } from '@/components/ui/button'

// The desktop app has no native folder picker bridge yet, so the folder is a typed or pasted path.
export function AddProjectForm() {
  const [state, action, pending] = useActionState<AddProjectResult, FormData>(addProjectAction, {})
  return (
    <form action={action} className="space-y-2">
      <label htmlFor="project-folder" className="text-sm font-medium">
        Folder path
      </label>
      <div className="flex gap-2">
        <input
          id="project-folder"
          name="folder"
          required
          placeholder="~/code/my-app"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? 'project-folder-error' : undefined}
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 font-mono text-sm outline-none focus-visible:ring-[3px]"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Add folder
        </Button>
      </div>
      {state.error && (
        <p id="project-folder-error" role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </form>
  )
}
