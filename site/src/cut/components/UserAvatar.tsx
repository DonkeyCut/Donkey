import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// The signed-in user's picture, or the first letter of the name they go by.
//
// Provider avatars are hotlinked from the identity provider, so they fail for
// reasons this app can't fix — an expired URL, a provider that turns away
// requests carrying our referrer, an offline machine. The initial stands in
// whenever the image doesn't arrive, so a row never shows a broken icon.
export function UserAvatar({
  name,
  image,
  className,
  initialClassName,
}: {
  name: string;
  image?: string | null;
  className?: string;
  initialClassName?: string;
}) {
  return (
    <Avatar className={className}>
      {image && <AvatarImage src={image} alt="" referrerPolicy="no-referrer" />}
      <AvatarFallback className={cn(initialClassName)}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
