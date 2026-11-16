import { connection, type NextRequest } from 'next/server'
import { readCompanionImage } from '@/server/companions'

// The user's own companion picture, read from the data folder on each request.
export async function GET(request: NextRequest) {
  // Without this, Cache Components would prerender the response at build time.
  await connection()
  const image = await readCompanionImage()
  if (!image) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      'content-type': image.contentType,
      'x-content-type-options': 'nosniff',
      // companionImageUrl() adds ?v=<mtime>, so a versioned URL never changes; a bare one may.
      'cache-control': request.nextUrl.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'no-store',
    },
  })
}
