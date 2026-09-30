/**
 * The WASM ProRes decoder, registered with mediabunny on first need. A
 * ProRes master decodes through it in the page until its proxy lands, and
 * the in-tab export reads the master through it always.
 */

let registered: Promise<void> | null = null;

export function ensureProresDecoder(): Promise<void> {
  return (registered ??= import("@mediabunny/prores").then((m) => {
    m.registerProresDecoder();
  }));
}
