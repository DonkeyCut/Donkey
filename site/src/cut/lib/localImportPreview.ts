import { forgetRegistered, registerBlobFile } from "@/cut/lib/backend/browser/registry";
import { useLightbox, type LightboxItem } from "@/cut/lib/lightbox";

/** What the arriving tile already knows about the file, so the viewer opens
 * at the media's own shape with its frame showing. */
export type LocalImportFacts = { width?: number; height?: number; duration?: number; poster?: Blob };

/** The viewer owns these local bytes until it closes or opens another item. */
export function openLocalImport(file: File, kind: "video" | "image" | "audio", facts: LocalImportFacts = {}) {
  const path = `pending-preview/${crypto.randomUUID()}`;
  const src = registerBlobFile(path, file);
  const poster = facts.poster && URL.createObjectURL(facts.poster);
  const item: LightboxItem = {
    kind, src, name: file.name, prompt: "", assetId: null, bare: true,
    ...(facts.width && facts.height ? { ratio: facts.width / facts.height } : {}),
    ...(facts.duration ? { duration: facts.duration } : {}),
    ...(poster ? { poster } : {}),
  };
  useLightbox.getState().open(item);
  const unsubscribe = useLightbox.subscribe((state) => {
    if (state.item === item) return;
    unsubscribe();
    forgetRegistered(path);
    if (poster) URL.revokeObjectURL(poster);
  });
}
