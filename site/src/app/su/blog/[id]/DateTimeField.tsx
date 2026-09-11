"use client";

import { CalendarIcon } from "lucide-react";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
const timeOf = (date: Date | null) => (date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : "");

// The chosen day at the time already set, or at the current time when none was.
function dayAt(day: Date, current: Date | null): string {
  const base = current ?? new Date();
  const next = new Date(day);
  next.setHours(base.getHours(), base.getMinutes(), 0, 0);
  return next.toISOString();
}

// The day already set (today when none was) at the typed time.
function timeAt(time: string, current: Date | null): string | null {
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const next = current ? new Date(current) : new Date();
  next.setHours(hours, minutes, 0, 0);
  return next.toISOString();
}

// A day and a time, kept as one instant. The calendar picks the day, the time
// box the wall-clock time in the editor's zone; either alone starts from now.
export function DateTimeField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | null;
  onChange: (iso: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const date = value ? new Date(value) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "w-full justify-start gap-2 font-normal",
          !date && "text-muted-foreground",
        )}
      >
        <CalendarIcon className="size-4" />
        {date ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Pick a date"}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={date ?? undefined}
          onSelect={(day) => onChange(day ? dayAt(day, date) : null)}
          captionLayout="dropdown"
        />
        <div className="flex items-center gap-2 border-t p-2">
          <Input
            type="time"
            aria-label="Time"
            value={timeOf(date)}
            onChange={(event) => {
              const next = timeAt(event.target.value, date);
              if (next) onChange(next);
            }}
            className="w-auto"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={!date}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
