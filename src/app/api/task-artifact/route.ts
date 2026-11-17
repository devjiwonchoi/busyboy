import { connection, type NextRequest } from 'next/server'
import { readTaskArtifact } from '@/server/cards/task-artifact'
import { dataFolder } from '@/server/config'

// A screenshot or trace cited by VERIFY.md. The note names a file in the task
// worktree; this serves that file and nothing outside it.
export async function GET(request: NextRequest) {
  // Without this, Cache Components would prerender the response at build time.
  await connection()
  const task = request.nextUrl.searchParams.get('task')
  const file = request.nextUrl.searchParams.get('file')
  if (!task || !file) return new Response(null, { status: 404 })
  const artifact = await readTaskArtifact({ folder: await dataFolder(), taskId: task, file })
  if (artifact === 'too-large') return new Response(null, { status: 413 })
  if (!artifact) return new Response(null, { status: 404 })
  const filename = artifact.name.replace(/[\r\n"]/g, '') || 'artifact'
  return new Response(new Uint8Array(artifact.bytes), {
    headers: {
      'content-type': artifact.contentType,
      'content-disposition': `${artifact.inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })
}
