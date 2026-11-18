import { dataFolder } from "@/server/config";
import { readSavedImage } from "@/server/director/attachments";
import { directorDataFolder } from "@/server/director/chat";
import { requireTrustedRequest } from "@/server/trusted-request";

export async function GET(request: Request) {
  await requireTrustedRequest();
  const file = new URL(request.url).searchParams.get("file") ?? "";
  const image = await readSavedImage(directorDataFolder(dataFolder()), file);
  if (!image) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.mediaType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
