import { forgetRegistered, registerBlobFile } from "@/cut/lib/backend/browser/registry";
import { useLightbox, type LightboxItem } from "@/cut/lib/lightbox";

/** The viewer owns these local bytes until it closes or opens another item. */
export function openLocalImport(file: File, kind: "video" | "image" | "audio") {
  const path = `pending-preview/${crypto.randomUUID()}`;
  const src = registerBlobFile(path, file);
  const item: LightboxItem = { kind, src, name: file.name, prompt: "", assetId: null, bare: true };
  useLightbox.getState().open(item);
  const unsubscribe = useLightbox.subscribe((state) => {
    if (state.item === item) return;
    unsubscribe();
    forgetRegistered(path);
  });
}
