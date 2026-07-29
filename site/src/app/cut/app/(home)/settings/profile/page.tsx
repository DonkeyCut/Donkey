"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";

import { AvatarDialog } from "@/app/cut/app/(home)/settings/profile/AvatarDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/cut/components/UserAvatar";
import { openOnboarding } from "@/cut/lib/onboarding";
import {
  useAccountProfile,
  useUpdateDisplayName,
  visibleName,
} from "@/queries/accountProfile";

// The account's own page: who you're signed in as, and the one thing about it
// you can change. The display name is the product's; the Google account keeps
// the name and email it signed in with.
export default function CutProfilePage() {
  const { data: profile, isPending, isError } = useAccountProfile();
  const update = useUpdateDisplayName();
  // Null means "not edited yet", so the field follows the saved value until
  // the user types and again once a save lands.
  const [draft, setDraft] = useState<string | null>(null);
  const [editingAvatar, setEditingAvatar] = useState(false);

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (isError || !profile) {
    return <p className="text-sm text-red-600">Couldn&apos;t load your profile.</p>;
  }

  const value = draft ?? profile.displayName ?? "";
  const dirty = value.trim() !== (profile.displayName ?? "");

  const save = () => {
    update.mutate(value.trim() || null, { onSuccess: () => setDraft(null) });
  };

  return (
    <div className="max-w-2xl space-y-6 pb-9">
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center gap-3">
          {/* The picture is the way into its own editor — pick, frame, save. */}
          <button
            type="button"
            aria-label="Change profile picture"
            onClick={() => setEditingAvatar(true)}
            className="group relative cursor-pointer rounded-lg"
          >
            <UserAvatar
              name={visibleName(profile, profile.name)}
              image={profile.image}
              className="size-[3.6rem]"
              initialClassName="text-lg"
            />
            <span className="absolute inset-0 rounded-lg bg-black/40 opacity-0 transition-opacity group-hover:opacity-100" />
            {/* Pinned to the corner rather than shown on hover, so the picture
                reads as editable before anyone points at it. */}
            <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
              <Pencil className="size-3" />
            </span>
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {visibleName(profile, profile.name)}
            </div>
            <div className="truncate text-sm text-muted-foreground">{profile.email}</div>
          </div>
        </div>

        <div className="mt-5 border-t pt-5">
          <Label htmlFor="display-name">Display name</Label>
          <div className="mt-3 flex items-center gap-2">
            <Input
              id="display-name"
              className="max-w-xs"
              maxLength={60}
              placeholder={profile.name}
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dirty) save();
              }}
            />
            <Button disabled={!dirty || update.isPending} onClick={save}>
              Save
            </Button>
          </div>
          {update.isError && (
            <p className="mt-2 text-sm text-red-600">
              Couldn&apos;t save that name — try again.
            </p>
          )}
        </div>
      </div>

      {/* The welcome sequence is a full-window overlay mounted in the app
          shell, so this row asks for it rather than rendering it. */}
      <div className="flex items-center justify-between gap-4 rounded-xl border bg-card p-5">
        <div className="min-w-0">
          <div className="text-sm font-medium">Welcome tour</div>
          <p className="mt-1 text-sm text-muted-foreground">
            The short intro to Donkey Cut you saw when you signed up.
          </p>
        </div>
        <Button variant="outline" onClick={openOnboarding}>
          Replay
        </Button>
      </div>

      <AvatarDialog
        open={editingAvatar}
        onOpenChange={setEditingAvatar}
        hasCustomImage={profile.image?.startsWith("/api/account/avatar") === true}
      />
    </div>
  );
}
