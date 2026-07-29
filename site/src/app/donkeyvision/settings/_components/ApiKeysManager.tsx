"use client";

import { Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  useApiKeys,
  useCreateApiKey,
  useDeleteApiKey,
  type CreatedApiKey,
} from "@/queries/apiKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function ApiKeysManager() {
  const keys = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();

  const [name, setName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    createKey.mutate(trimmed, {
      onSuccess: (result) => {
        setCreatedKey(result);
        setName("");
        setCreateOpen(false);
      },
    });
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">API Keys</h1>
        <Button onClick={() => setCreateOpen(true)}>Create key</Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          {keys.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : keys.data && keys.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>{key.name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {(key.prefix ?? "") + (key.start ?? "")}…
                    </TableCell>
                    <TableCell>
                      {new Date(key.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {key.lastRequest
                        ? new Date(key.lastRequest).toLocaleDateString()
                        : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        disabled={deleteKey.isPending}
                        onClick={() => deleteKey.mutate(key.id)}
                        size="sm"
                        variant="destructive"
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No API keys yet.</p>
          )}
        </CardContent>
      </Card>

      <Link
        href="/donkeyvision#api"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Info className="h-4 w-4" />
        Learn how to use your API keys
      </Link>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleCreate();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={createKey.isPending || !name.trim()}
              onClick={handleCreate}
            >
              {createKey.isPending ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createdKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKey(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              Secrets are shown only once at creation. Store them securely.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted p-3 font-mono text-sm break-all">
            {createdKey?.secret}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                if (createdKey) {
                  void navigator.clipboard.writeText(createdKey.secret);
                }
              }}
              variant="secondary"
            >
              Copy
            </Button>
            <Button onClick={() => setCreatedKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
