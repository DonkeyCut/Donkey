"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Replace } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { commitReplace, openReplace } from "@/cut/lib/replaceFlow";
import { useEditor } from "@/cut/lib/store";
import { footageSlots, slotSeconds } from "@/cut/lib/templateFill";
import { formatTime } from "@/cut/lib/time";

type Imports = (
  files: File[],
  opts: {
    mediaOnly: true;
    onOutcome: (result: { file: File; assetId: string } | { file: File; failed: true }) => void;
  }
) => Promise<unknown>;

/** The sheet a template copy opens with: its footage slots in play order, and
 * two ways to fill them. Clips chosen from disk fill the slots in order; a
 * slot's own button opens the replace picker on it, with Project Files, the
 * Library and the window that picks the part to play. A slot left alone keeps
 * its sample. */
export function TemplateFillSheet({ onImport, onClose }: { onImport: Imports; onClose: () => void }) {
  const t = useTranslations("home.templates.fill");
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const slots = footageSlots(clips, assets);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  // Import the picked files, then hand them to the slots in order, the way
  // the files were picked. A file that fails to import leaves its slot alone.
  const fillFrom = async (files: File[]) => {
    setBusy(true);
    const landed = new Map<File, string>();
    await onImport(files, {
      mediaOnly: true,
      onOutcome: (r) => {
        if ("assetId" in r && r.assetId) {
          landed.set(r.file, r.assetId);
        }
      },
    });
    const s = useEditor.getState();
    const order = footageSlots(s.clips, s.assets);
    files.forEach((file, i) => {
      const slot = order[i];
      const asset = s.assets.find((a) => a.id === landed.get(file));
      if (!slot || !asset) {
        return;
      }
      commitReplace({ kind: "clip", id: slot.id }, asset, 0);
    });
    setBusy(false);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ol className="flex flex-col gap-1">
            {slots.map((slot, i) => (
              <li key={slot.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-muted">
                <span className="text-[13px] tabular-nums">
                  {t("slot", { n: i + 1, seconds: formatTime(slotSeconds(slot)) })}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("replaceSlot")}
                        onClick={() => {
                          onClose();
                          openReplace({ kind: "clip", id: slot.id });
                        }}
                      />
                    }
                  >
                    <Replace />
                  </TooltipTrigger>
                  <TooltipContent>{t("replaceSlot")}</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ol>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("skip")}
          </Button>
          <Button disabled={busy || slots.length === 0} onClick={() => input.current?.click()}>
            {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
            {t("pick")}
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept="video/*,image/*"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length > 0) {
                void fillFrom(files);
              }
            }}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
