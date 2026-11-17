import { connection, type NextRequest } from 'next/server'
import { dataFolder } from '@/server/config'
import { readChatImage } from '@/server/director/chat'

export async function GET(request: NextRequest) {
  await connection();
  const params = request.nextUrl.searchParams
  const file = params.get('file')
  if (!file) return new Response(null, { status: 404 })
  const image = await readChatImage({ folder: await dataFolder(), chat: params.get('chat'), task: params.get('task'), file })
  if (!image) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      'content-type': image.mediaType,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
    },
  })
}
