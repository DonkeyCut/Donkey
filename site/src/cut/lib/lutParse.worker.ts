/**
 * The LUT parse worker: turns a .cube or .3dl file's bytes into its tables off
 * the main thread (lutParse.ts), handing the tables back by transfer.
 */

import { parseLutFile } from "@donkeycut/effects-kit";
import type { LutParseReply, LutParseRequest } from "./lutParse";

const post = (reply: LutParseReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<LutParseRequest>) => {
  const { id, fileName, bytes } = e.data;
  try {
    const lut = parseLutFile(fileName, new TextDecoder().decode(bytes));
    const transfer = [lut.shaper?.data.buffer, lut.cube?.data.buffer].filter((b): b is ArrayBuffer => !!b);
    post({ id, lut }, transfer);
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
