import { Label } from "@/components/ui/label";

// A labelled control in an su form. The control sits at the bottom, so in a
// row of fields the inputs stay level when one label wraps.
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 *:last:mt-auto">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
