import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";
import type { APIRoute } from "astro";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
