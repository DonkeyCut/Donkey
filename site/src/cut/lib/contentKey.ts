/** A linked library item's identity: enough SHA-256 of its bytes to never
 * collide in one account's shelf. The same file on two shelves is one item
 * and one id, which is what lets a project change residency without a word
 * of it being rewritten. */
export async function contentKey(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
