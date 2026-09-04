"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

// A value editor drawn from a setting's JSON schema (the registry's zod schema,
// converted on the server). One level of object nests as a fieldset; anything
// deeper or stranger falls back to JSON text, which the route still validates.

export type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  description?: string;
};

type Props = {
  id: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  depth?: number;
};

// A nullable scalar arrives as anyOf [scalar, null]; the form shows the
// scalar's control with "off" standing for null.
function nullable(schema: JsonSchema): { inner: JsonSchema; nullable: boolean } {
  if (!schema.anyOf) return { inner: schema, nullable: false };
  const inner = schema.anyOf.find((s) => s.type !== "null");
  const hasNull = schema.anyOf.some((s) => s.type === "null");
  return inner && hasNull && schema.anyOf.length === 2
    ? { inner, nullable: true }
    : { inner: schema, nullable: false };
}

export function SchemaField({ id, schema: raw, value, onChange, depth = 0 }: Props) {
  const { inner, nullable: isNullable } = nullable(raw);
  const type = Array.isArray(inner.type) ? inner.type[0] : inner.type;

  if (inner.enum) {
    return (
      <Select value={String(value)} onValueChange={(v) => onChange(v)}>
        <SelectTrigger id={id} className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {inner.enum.map((option) => (
            <SelectItem key={String(option)} value={String(option)}>
              {String(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (type === "boolean") {
    return <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />;
  }

  if (type === "number" || type === "integer") {
    return (
      <div className="flex items-center gap-2">
        {isNullable ? (
          <Switch
            aria-label="Rule on"
            checked={value !== null}
            onCheckedChange={(on) => onChange(on ? (inner.minimum ?? 0) : null)}
          />
        ) : null}
        <Input
          id={id}
          className="w-28"
          type="number"
          disabled={isNullable && value === null}
          min={inner.minimum}
          max={inner.maximum}
          step={type === "integer" ? 1 : "any"}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === "" ? (isNullable ? null : 0) : Number(next));
          }}
        />
        {isNullable && value === null ? (
          <span className="text-xs text-muted-foreground">off</span>
        ) : null}
      </div>
    );
  }

  if (type === "string") {
    return (
      <Input
        id={id}
        className="max-w-md"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (type === "array" && inner.items && inner.items.type === "string") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Input
        id={id}
        className="max-w-md"
        placeholder="comma separated"
        value={list.join(", ")}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }

  if (type === "object" && inner.properties && depth === 0) {
    const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return (
      <div className="grid gap-3">
        {Object.entries(inner.properties).map(([name, property]) => (
          <div key={name} className="grid grid-cols-[180px_1fr] items-center gap-3">
            <Label htmlFor={`${id}-${name}`} className="text-muted-foreground">
              {name}
            </Label>
            <SchemaField
              id={`${id}-${name}`}
              schema={property}
              value={record[name]}
              onChange={(next) => onChange({ ...record, [name]: next })}
              depth={depth + 1}
            />
          </div>
        ))}
      </div>
    );
  }

  return <JsonField id={id} value={value} onChange={onChange} />;
}

function JsonField({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        className="font-mono text-xs"
        rows={6}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          try {
            onChange(JSON.parse(event.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? <p className="text-xs text-destructive">Not valid JSON.</p> : null}
    </div>
  );
}
