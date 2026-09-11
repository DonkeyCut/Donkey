"use client";

import { X } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

// A list of words as chips. Enter or a comma adds what is typed, Backspace on
// an empty box removes the last chip, and the browser offers the words other
// posts already use.
export function TagInput({
  id,
  value,
  onChange,
  suggestions = [],
  placeholder,
  normalize = (word) => word.trim(),
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  normalize?: (word: string) => string;
}) {
  const [typed, setTyped] = useState("");
  const listId = useId();

  const add = (raw: string) => {
    const words = raw
      .split(",")
      .map(normalize)
      .filter((word) => word.length > 0 && !value.includes(word));
    if (words.length > 0) onChange([...value, ...words]);
    setTyped("");
  };

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((word) => (
            <Badge key={word} variant="secondary" className="gap-1 pr-1">
              {word}
              <button
                type="button"
                aria-label={`Remove ${word}`}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((other) => other !== word))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <Input
        id={id}
        list={listId}
        value={typed}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => setTyped(event.target.value)}
        onBlur={() => {
          if (typed.trim()) add(typed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add(typed);
          } else if (event.key === "Backspace" && typed === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
      <datalist id={listId}>
        {suggestions
          .filter((word) => !value.includes(word))
          .map((word) => (
            <option key={word} value={word} />
          ))}
      </datalist>
    </div>
  );
}
