import { CircleDashed } from "lucide-react";

import { cn } from "@/lib/utils";

export type ChatStatus = "working" | "unread" | null;

/** The corner mark on whatever opens the chat. `className` carries the surface
 * it sits on, so the halo behind the dot matches the button's background. */
export function ChatStatusBadge({ status, className }: { status: ChatStatus; className?: string }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "pointer-events-none absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-background",
        className,
      )}
    >
      {status === "working" ? (
        <CircleDashed role="img" aria-label="Chat working" className="size-3! animate-spin text-muted-foreground" />
      ) : (
        <span role="img" aria-label="Unread chat reply" className="size-2 rounded-full bg-blue-500" />
      )}
    </span>
  );
}
