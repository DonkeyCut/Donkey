// Media a hosted inference request carries by reference instead of by value.
//
// A video editor's requests carry pictures and sound: reference sheets, shot
// keyframes, contact sheets, chat attachments. Base64 in the request body is a
// dead end — the routes run as serverless functions behind a request-body limit
// enforced at the edge, so an oversized body is refused before the route runs
// and the browser only sees a dropped connection. So bytes travel out of band:
// the client PUTs them straight to object storage (/api/inference/uploads mints
// the URL) and sends a placeholder in their place. This resolves those
// placeholders back into inline data on the way to the model, where the request
// is server-to-server and the only ceiling is the model's own.
//
// A placeholder is `{ blobRef, blobField, mimeType }`: `blobRef` is the object
// key, `blobField` names the field the base64 belongs in. Naming the field is
// what keeps this one function enough for every payload shape — asset inputs
// read `data`, content parts read `dataBase64` — with no consumer aware that
// media ever left the body.
import { getObject, head, presignGet } from "@/cut/server/cloud/r2";
import { isJsonObject } from "@/lib/inference/json";
import { InferenceProviderError, type JsonValue } from "@/lib/inference/providers";

// What one request may inline once resolved. Sized to sit under the model's own
// per-request ceiling: past it the upstream call fails on bytes we already
// counted, so the caller hears about it here instead.
const MAX_RESOLVED_BYTES = 20 * 1024 * 1024;

/** True for a value shaped like a stored-blob placeholder. `blobUrl: true`
 * asks for a time-limited read URL in place of inline bytes — for a provider
 * that fetches its input itself, where a long video would blow the inline
 * ceiling. */
function blobRefOf(value: JsonValue): { key: string; field: string; asUrl: boolean } | null {
  if (!isJsonObject(value)) return null;
  const key = value.blobRef;
  const field = value.blobField;
  if (typeof key !== "string" || !key) return null;
  return {
    key,
    field: typeof field === "string" && field ? field : "data",
    asUrl: value.blobUrl === true,
  };
}

export type BlobReader = (key: string) => Promise<{ bytes: Buffer; mime: string } | null>;

/** The object's bytes, retried once — a single storage blip must not cost a
 * render that was about to be billed. */
const readBlob: BlobReader = async (key) => {
  const first = await getObject(key).catch(() => null);
  if (first) return first;
  return getObject(key).catch(() => null);
};

/**
 * Replace every stored-blob placeholder in `body` with the bytes it points at.
 * Keys are scoped to the caller: a placeholder naming another user's object is
 * rejected rather than read. Returns the body unchanged when it carries none.
 */
export async function resolveInferenceBlobs(
  body: JsonValue,
  userId: string,
  read: BlobReader = readBlob
): Promise<JsonValue> {
  const scope = `cut/inference/${userId}/`;
  let resolved = 0;

  const walk = async (value: JsonValue): Promise<JsonValue> => {
    if (Array.isArray(value)) {
      return Promise.all(value.map(walk));
    }
    if (!isJsonObject(value)) {
      return value;
    }
    const ref = blobRefOf(value);
    if (!ref) {
      const out: { [key: string]: JsonValue } = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = await walk(v);
      }
      return out;
    }
    if (!ref.key.startsWith(scope)) {
      throw new InferenceProviderError("That attachment does not belong to this account.", {
        statusCode: 403,
        code: "blob_not_owned",
      });
    }
    if (ref.asUrl) {
      if (!(await head(ref.key))) {
        throw new InferenceProviderError(
          "An attached file is no longer in storage. Send the request again.",
          { statusCode: 400, code: "blob_missing" }
        );
      }
      const rest = { ...value };
      delete rest.blobRef;
      delete rest.blobField;
      delete rest.blobUrl;
      return { ...rest, [ref.field]: await presignGet(ref.key) };
    }
    const object = await read(ref.key);
    if (!object) {
      throw new InferenceProviderError(
        "An attached file is no longer in storage. Send the request again.",
        { statusCode: 400, code: "blob_missing" }
      );
    }
    resolved += object.bytes.byteLength;
    if (resolved > MAX_RESOLVED_BYTES) {
      throw new InferenceProviderError(
        "This request carries more media than the model can take at once. Use fewer or shorter attachments.",
        { statusCode: 413, code: "attachments_too_large" }
      );
    }
    const rest = { ...value };
    delete rest.blobRef;
    delete rest.blobField;
    return {
      ...rest,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : object.mime,
      [ref.field]: object.bytes.toString("base64"),
    };
  };

  return walk(body);
}
