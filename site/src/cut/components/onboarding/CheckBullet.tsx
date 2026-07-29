import { Check } from "lucide-react";

// The landing's list marker: a ringed check, black on white, whatever colour
// the card behind it is. Shared by the slides that list what you get.
export function CheckBullet() {
  return (
    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-white">
      <Check size={14} />
    </span>
  );
}
