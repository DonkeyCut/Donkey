import { Img } from "react-email";

// The Donkey Cut mark at the top of an email. `src` is the `cid:` reference in
// real sends (the sender attaches the bytes from logo.ts) and the data URI in
// preview.
export function DonkeyMark({ src }: { src: string }) {
  return (
    <Img src={src} alt="Donkey Cut" width="48" height="48" className="mb-4" />
  );
}
