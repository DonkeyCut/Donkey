import { CircleDashed } from "lucide-react";

export type ChatStatus = "working" | "unread" | null;

export function ChatStatusBadge({ status }: { status: ChatStatus }) {
  if (!status) return null;
  return (
    <span className="pointer-events-none absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full bg-background">
      {status === "working" ? (
        <CircleDashed role="img" aria-label="Chat working" className="size-3! animate-spin text-muted-foreground" />
      ) : (
        <span role="img" aria-label="Unread chat reply" className="size-2 rounded-full bg-blue-500" />
      )}
    </span>
  );
}
