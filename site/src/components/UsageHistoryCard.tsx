"use client";

import { Fragment, useRef, useState, type KeyboardEvent } from "react";

import { useUsage, type VisionUsage } from "@/queries/billing";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type RecentCall = VisionUsage["recent"][number];

// Stable identity for a call so expansion state survives a background refetch
// (which can reorder/prepend rows) instead of being pinned to an array index.
function callKey(call: RecentCall): string {
  return `${call.createdAt}-${call.product}-${call.requestKind}-${call.costCredits}`;
}

// Cents by default, but show a third decimal when a value carries sub-cent
// precision (many app calls cost a fraction of a cent) so they aren't all
// "$0.00". Clean values stay at 2 decimals — min 2 / max 3 fraction digits.
function formatCostValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}

function formatCallCost(call: RecentCall): string {
  if (call.billingStatus === "included") {
    return "Included";
  }
  return formatCostValue(Number.parseFloat(call.costCredits));
}

function conversationLabel(conversationId: string): string {
  // Conversation ids are long opaque strings; a short prefix is enough to tell
  // groups apart without dominating the row.
  return `Conversation ${conversationId.slice(0, 8)}`;
}

// A conversation block's combined cost for its header. An all-included block has
// no credit cost, so label it "Included" rather than "$0.00".
function blockCostSummary(calls: RecentCall[]): string {
  if (calls.every((call) => call.billingStatus === "included")) {
    return "Included";
  }
  const total = calls.reduce((sum, call) => {
    const value = Number.parseFloat(call.costCredits);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return formatCostValue(total);
}

// Share of the block's input tokens the provider served from cache, across all its calls. This is the
// signal for whether our stable prompt prefix is being reused: a near-0% share over a many-call run means
// the cache isn't being hit and we're paying full input rate every step. null when the block billed no
// input tokens (nothing to cache).
function blockCachedShare(calls: RecentCall[]): number | null {
  let input = 0;
  let cached = 0;
  for (const call of calls) {
    input += call.usage.inputTokens;
    cached += call.usage.cachedInputTokens;
  }
  return input > 0 ? Math.round((cached / input) * 100) : null;
}

// Per-row annotation for the interleaved timeline. Rows keep the server's
// chronological (newest-first) order: background (no-conversation) calls are
// NEVER pulled together — each stays wherever it happened, between the groups. A
// maximal run of consecutive same-conversation calls is one "block"; every row
// in it shares a blockKey (the run's start index; -1 for background) plus the
// run's total count and cost, so a header can render at the run's start and again
// at a page top when a run carries across the page boundary.
type RowAnnotation = {
  blockKey: number;
  blockCount: number;
  blockSummary: string;
  blockCachedShare: number | null;
};

function annotateRows(rows: RecentCall[]): RowAnnotation[] {
  const annotations: RowAnnotation[] = rows.map(() => ({
    blockKey: -1,
    blockCount: 0,
    blockSummary: "",
    blockCachedShare: null,
  }));
  let index = 0;
  while (index < rows.length) {
    const conversationId = rows[index].conversationId;
    if (conversationId === null) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end].conversationId === conversationId) {
      end += 1;
    }
    const block = rows.slice(index, end);
    const summary = blockCostSummary(block);
    const cachedShare = blockCachedShare(block);
    for (let i = index; i < end; i += 1) {
      annotations[i] = {
        blockKey: index,
        blockCount: block.length,
        blockSummary: summary,
        blockCachedShare: cachedShare,
      };
    }
    index = end;
  }
  return annotations;
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

function formatDuration(millis: number): string {
  return millis >= 1000 ? `${(millis / 1000).toFixed(1)}s` : `${millis}ms`;
}

const tabs = [
  { key: "app", label: "App" },
  { key: "vision", label: "Vision API" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

// Page the table client-side, capped so the control never grows past 5 pages.
const ROWS_PER_PAGE = 25;
const MAX_PAGES = 5;

function CallDetail({ call }: { call: RecentCall }) {
  const { usage } = call;
  const imageBilled = usage.generationCount > 0;
  const tokenBilled =
    usage.inputTokens > 0 || usage.outputTokens > 0 || usage.totalTokens > 0;
  // Vision parses report no token/image usage — they're a flat per-call charge,
  // so there's no breakdown to show, just the pricing model.
  const flatRate =
    !imageBilled && !tokenBilled && call.requestKind === "vision_parse";

  const stats: { label: string; value: string }[] = [];
  if (imageBilled) {
    stats.push({
      label: "Images generated",
      value: formatTokens(usage.generationCount),
    });
  }
  if (tokenBilled) {
    // Cached input is billed at a fraction of the input rate, so the cached SHARE is the signal for
    // whether the provider is reusing our stable prompt prefix. Show it as its own stat (with the share)
    // and always — a 0% cached call is a cache MISS worth seeing, not an absence to hide.
    const cachedShare =
      usage.inputTokens > 0
        ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)
        : 0;
    stats.push(
      { label: "Input tokens", value: formatTokens(usage.inputTokens) },
      {
        label: "Cached input",
        value: `${formatTokens(usage.cachedInputTokens)} (${cachedShare}%)`,
      },
      { label: "Output tokens", value: formatTokens(usage.outputTokens) },
      { label: "Total tokens", value: formatTokens(usage.totalTokens) },
    );
  }
  // Only some (audio-priced) calls report a duration; omit it otherwise.
  if (usage.durationMillis > 0) {
    stats.push({ label: "Duration", value: formatDuration(usage.durationMillis) });
  }

  // Explain what drove the cost in terms of how the call is priced.
  const explanation = imageBilled
    ? "Image generation is priced per image, not by tokens."
    : tokenBilled
      ? "Cost is driven by tokens, and input dominates here. Cached input is an unchanged prompt prefix the provider reuses at a fraction of the rate; a low cached share on a repeated call means the cache isn't being hit."
      : flatRate
        ? "Flat rate — vision parses are billed per call."
        : "No billable usage was recorded for this call.";

  return (
    <div className="space-y-3 px-2 py-1 text-sm">
      <p className="text-muted-foreground">{explanation}</p>
      {stats.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt className="text-xs text-muted-foreground">{stat.label}</dt>
              <dd className="font-medium tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {call.errorCode ? (
        <p className="text-destructive">Error: {call.errorCode}</p>
      ) : null}
    </div>
  );
}

// showVision=false (Cut's usage page) drops the Vision API tab and shows only
// app calls. plain=true drops the card chrome entirely — the table renders
// directly on the page and stretches to the space its parent gives it.
export function UsageHistoryCard({
  showVision = true,
  plain = false,
}: {
  showVision?: boolean;
  plain?: boolean;
}) {
  const usage = useUsage();
  const [tab, setTab] = useState<TabKey>("app");
  const [page, setPage] = useState(1);
  // Keyed by call identity (not row index) so a refetch can't leave the open
  // detail pinned to whatever row now sits at that index.
  const [expanded, setExpanded] = useState<string | null>(null);
  // One ref per rendered row so arrow keys can move focus to the sibling row.
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  if (usage.isLoading) {
    if (plain) {
      return <Skeleton className="h-64 w-full" />;
    }
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  const recent = usage.data?.recent ?? [];
  const tabRows = recent.filter((call) => call.product === tab);
  // Annotate in the server's chronological order so conversations group in place
  // and individual (no-conversation) calls stay interleaved between them.
  const annotations = annotateRows(tabRows);

  const totalPages = Math.min(
    MAX_PAGES,
    Math.max(1, Math.ceil(tabRows.length / ROWS_PER_PAGE)),
  );
  // Clamp in case rows shrank (refetch / tab change) below the current page.
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * ROWS_PER_PAGE;
  const pageRows = tabRows.slice(pageStart, pageStart + ROWS_PER_PAGE);

  const selectTab = (next: TabKey) => {
    setTab(next);
    setPage(1);
    setExpanded(null);
  };

  const goToPage = (next: number) => {
    setPage(next);
    setExpanded(null);
  };

  const focusRow = (index: number) => {
    const call = pageRows[index];
    if (!call) {
      return;
    }
    setExpanded(callKey(call));
    rowRefs.current[index]?.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(Math.min(index + 1, pageRows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(Math.max(index - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const key = callKey(pageRows[index]);
      setExpanded(expanded === key ? null : key);
    } else if (event.key === "Escape") {
      setExpanded(null);
    }
  };

  // In a height-constrained flex column (Cut's usage page) the wrapper fills
  // the remaining space, the table body scrolls on its own with the column
  // header row pinned, and the pagination stays visible below. In normal flow
  // (the apex settings) these classes are inert and the card grows as before.
  const body = (
    <>
        {showVision ? (
        <div className="inline-flex rounded-md border p-0.5">
          {tabs.map((item) => (
            <button
              key={item.key}
              onClick={() => selectTab(item.key)}
              type="button"
              className={cn(
                "rounded px-3 py-1 text-sm font-medium transition-colors",
                tab === item.key
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        ) : null}

        {/* The table's own container must stay overflow-visible so the sticky
            header row pins against the real scroll ancestor: this wrapper in
            card mode, the surrounding pane in plain mode. */}
        <div
          className={cn(
            "[&_[data-slot=table-container]]:overflow-visible",
            !plain && "min-h-0 flex-1 overflow-y-auto",
          )}
        >
        {tabRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No {tab === "app" ? "app" : "Vision API"} calls yet.
          </p>
        ) : (
          <Table>
            <TableHeader
              className={cn(
                "sticky top-0 z-10",
                plain ? "bg-background" : "bg-card",
              )}
            >
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((call, index) => {
                const globalIndex = pageStart + index;
                const annotation = annotations[globalIndex];
                const conversationId = call.conversationId;
                const inConversation =
                  annotation.blockKey !== -1 && annotation.blockCount > 1;
                const key = callKey(call);
                const isOpen = expanded === key;
                // Header before the first row of each conversation block (and at
                // the page top, since a block can carry over from the prior page).
                // Background rows render flat, in place, with no header.
                const prevAnnotation =
                  index === 0 ? null : annotations[globalIndex - 1];
                const startsBlock =
                  inConversation &&
                  (index === 0 ||
                    prevAnnotation?.blockKey !== annotation.blockKey);
                return (
                  <Fragment key={`${key}-${globalIndex}`}>
                    {startsBlock && conversationId !== null ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          className="font-bold text-muted-foreground"
                          colSpan={5}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span>{conversationLabel(conversationId)}</span>
                            <span className="tabular-nums">
                              {annotation.blockCount}{" "}
                              {annotation.blockCount === 1 ? "call" : "calls"}
                              {" · "}
                              {annotation.blockSummary}
                              {annotation.blockCachedShare !== null
                                ? ` · ${annotation.blockCachedShare}% cached`
                                : null}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                    <TableRow
                      ref={(el) => {
                        rowRefs.current[index] = el;
                      }}
                      aria-expanded={isOpen}
                      className="cursor-pointer outline-none focus-visible:bg-muted/50"
                      onClick={() => {
                        setExpanded(isOpen ? null : key);
                        rowRefs.current[index]?.focus();
                      }}
                      onKeyDown={(event) => onRowKeyDown(event, index)}
                      tabIndex={0}
                    >
                      {/* Indent a conversation's calls so they read as nested
                          under their header; background calls stay flush. */}
                      <TableCell className={cn(inConversation && "pl-8")}>
                        {new Date(call.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>{call.requestKind}</TableCell>
                      <TableCell>{call.model}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCallCost(call)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            call.status === "succeeded"
                              ? "secondary"
                              : "destructive"
                          }
                        >
                          {call.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell className="bg-muted/30" colSpan={5}>
                          <CallDetail call={call} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
        </div>

        {totalPages > 1 ? (
        <div className={cn(plain && "sticky bottom-0 z-10 bg-background py-3")}>
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  aria-disabled={currentPage <= 1}
                  className={
                    currentPage <= 1 ? "pointer-events-none opacity-50" : undefined
                  }
                  onClick={() => goToPage(Math.max(1, currentPage - 1))}
                />
              </PaginationItem>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                (pageNumber) => (
                  <PaginationItem key={pageNumber}>
                    <PaginationLink
                      isActive={pageNumber === currentPage}
                      onClick={() => goToPage(pageNumber)}
                    >
                      {pageNumber}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext
                  aria-disabled={currentPage >= totalPages}
                  className={
                    currentPage >= totalPages
                      ? "pointer-events-none opacity-50"
                      : undefined
                  }
                  onClick={() => goToPage(Math.min(totalPages, currentPage + 1))}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
        ) : null}
    </>
  );

  if (plain) {
    return <div className="space-y-4">{body}</div>;
  }
  return (
    <Card className="min-h-0 flex-1">
      <CardHeader>
        <CardTitle>Usage history</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        {body}
      </CardContent>
    </Card>
  );
}
