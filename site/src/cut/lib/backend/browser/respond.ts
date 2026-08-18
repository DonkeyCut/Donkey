// The replies the browser backend's handlers build. Shapes match the engine's
// (`server/http/*`), so a call site can't tell which backend answered.

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const err = (message: string, status: number) => json({ error: message }, status);

export const caught = (e: unknown, fallback: string) =>
  err(e instanceof Error ? e.message : fallback, 500);

/** Serve a store file the way serveFileRange presents it: typed bytes, an
 * attachment disposition when the URL asks to download. Blob-backed Responses
 * satisfy media-element range requests without explicit 206 handling. */
export function serveFile(file: File, name: string, download: boolean): Response {
  const headers: Record<string, string> = {};
  if (file.type) headers["Content-Type"] = file.type;
  if (download) headers["Content-Disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
  return new Response(file, { headers });
}
