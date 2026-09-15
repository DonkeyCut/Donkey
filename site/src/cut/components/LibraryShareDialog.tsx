"use client";

import { useEffect, useRef, useState } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShareDialog } from "@/cut/components/ShareDialog";
import { copyLibraryForSharing } from "@/cut/lib/libraryShareCopy";
import { refetchLibrary } from "@/cut/lib/queries";
import type { LibraryData } from "@/cut/lib/library";
import type { LibraryShareTarget } from "@/cut/lib/librarySharing";
import type { Residency } from "@/cut/lib/residency";

type Props = {
  target: LibraryShareTarget & { residency: Residency };
  library: LibraryData;
  onClose: () => void;
  onCopied: (target: LibraryShareTarget) => void;
};
export function LibraryShareDialog({ target, library, onClose, onCopied }: Props) {
  const [ready, setReady] = useState<LibraryShareTarget | null>(target.residency === "cloud" ? target : null);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const client = useQueryClient();
  const copy = async () => {
    if (started.current) return;
    started.current = true;
    setCopying(true);
    setError(null);
    try {
      const landed = await copyLibraryForSharing(target, target.residency, library);
      void refetchLibrary(client);
      if (mounted.current) {
        setReady(landed);
        onCopied(landed);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Could not copy to Cloud.");
    } finally {
      setCopying(false);
      started.current = false;
    }
  };
  if (ready) return <ShareDialog libraryTarget={ready} onClose={onClose} />;
  return <Dialog open onOpenChange={(open) => { if (!open && !copying) onClose(); }}>
    <DialogContent className="sm:max-w-sm" showCloseButton={!copying}>
      <DialogHeader><DialogTitle>Share {target.kind}</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">Copy this {target.kind} to Cloud so people can open it while your device is offline. Share settings will apply to the cloud copy. Your local files stay here.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={copying} onClick={() => void copy()}>{copying ? <Loader2 className="animate-spin" /> : <Cloud />}{copying ? "Copying to Cloud…" : "Copy to Cloud"}</Button>
    </DialogContent>
  </Dialog>;
}
