import { Img } from "react-email";

import { DONKEY_LOGO_CID } from "./logo";

// The Donkey Cut mark at the top of an email, referenced by Content-ID: the
// sender attaches the bytes from logo.ts under this id, so the image travels
// inside the message and no client fetches anything external. The preview
// server has no attachment to resolve, so it shows the alt box there.
export function DonkeyMark() {
  return (
    <Img
      src={`cid:${DONKEY_LOGO_CID}`}
      alt="Donkey Cut"
      width="48"
      height="48"
      className="mb-4"
    />
  );
}
