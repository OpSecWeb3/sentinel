"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

interface Channel {
  id: string;
  orgId: string;
  name: string;
  type: "email" | "webhook";
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

interface ChannelsResponse {
  data: Channel[];
}

/* ── page ────────────────────────────────────────────────────── */

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
    {},
  );
  const { toast, toasts, dismiss } = useToast();

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<"email" | "webhook">("webhook");
  const [createName, setCreateName] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [createRecipients, setCreateRecipients] = useState("");
  const [createLoading, setCreateLoading] = useState(false);

  // Confirm dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDesc, setConfirmDesc] = useState("");
  const [confirmResolve, setConfirmResolve] = useState<
    ((value: boolean) => void) | null
  >(null);

  function confirm(title: string, description: string): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmTitle(title);
      setConfirmDesc(description);
      setConfirmResolve(() => resolve);
      setConfirmOpen(true);
    });
  }

  function handleConfirmClose(result: boolean) {
    setConfirmOpen(false);
    confirmResolve?.(result);
  }

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ChannelsResponse>("/api/channels", {
        credentials: "include",
      });
      setChannels(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load channels");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  /* ── create channel ────────────────────────────────────────── */

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateLoading(true);
    try {
      const config: Record<string, unknown> =
        createType === "webhook"
          ? { url: createUrl }
          : {
              recipients: createRecipients
                .split(",")
                .map((r) => r.trim())
                .filter(Boolean),
            };

      const res = await apiFetch<{ data: Channel; generatedSecret?: string }>(
        "/api/channels",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: createName, type: createType, config }),
        },
      );

      setChannels((prev) => [res.data, ...prev]);
      setShowCreate(false);
      setCreateName("");
      setCreateUrl("");
      setCreateRecipients("");

      if (res.generatedSecret) {
        toast(
          `Channel created. Webhook secret: ${res.generatedSecret} — save this now.`,
        );
      } else {
        toast("Channel created.");
      }
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to create channel",
      );
    } finally {
      setCreateLoading(false);
    }
  }

  /* ── test channel ──────────────────────────────────────────── */

  async function testChannel(channel: Channel) {
    setActionLoading((prev) => ({ ...prev, [`test-${channel.id}`]: true }));
    try {
      await apiFetch(`/api/channels/${channel.id}/test`, {
        method: "POST",
        credentials: "include",
      });
      toast(`Test notification sent to "${channel.name}".`);
    } catch (err) {
      toast(
        err instanceof Error
          ? `Test failed: ${err.message}`
          : "Test notification failed",
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [`test-${channel.id}`]: false }));
    }
  }

  /* ── toggle enabled ────────────────────────────────────────── */

  async function toggleEnabled(channel: Channel) {
    setActionLoading((prev) => ({ ...prev, [channel.id]: true }));
    try {
      await apiFetch(`/api/channels/${channel.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      setChannels((prev) =>
        prev.map((c) =>
          c.id === channel.id ? { ...c, enabled: !c.enabled } : c,
        ),
      );
    } catch {
      toast("Failed to update channel.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [channel.id]: false }));
    }
  }

  /* ── delete channel ────────────────────────────────────────── */

  async function deleteChannel(channel: Channel) {
    const confirmed = await confirm(
      "Delete Channel",
      `Are you sure you want to delete "${channel.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;
    setActionLoading((prev) => ({ ...prev, [channel.id]: true }));
    try {
      await apiFetch(`/api/channels/${channel.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      setChannels((prev) => prev.filter((c) => c.id !== channel.id));
      toast(`Channel "${channel.name}" deleted.`);
    } catch {
      toast("Failed to delete channel.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [channel.id]: false }));
    }
  }

  /* ── render ────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        description={confirmDesc}
        onClose={handleConfirmClose}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ channels ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} notification channels (email, webhook)
          </p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "[cancel]" : "+ New Channel"}
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              $ channels create
            </p>
            <form onSubmit={handleCreate} className="space-y-3">
              {/* Type toggle */}
              <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">--type</span>
                <button
                  type="button"
                  onClick={() => setCreateType("webhook")}
                  className={cn(
                    "transition-colors",
                    createType === "webhook"
                      ? "text-foreground"
                      : "text-muted-foreground/60 hover:text-foreground",
                  )}
                >
                  {createType === "webhook" ? "[webhook]" : "webhook"}
                </button>
                <button
                  type="button"
                  onClick={() => setCreateType("email")}
                  className={cn(
                    "transition-colors",
                    createType === "email"
                      ? "text-foreground"
                      : "text-muted-foreground/60 hover:text-foreground",
                  )}
                >
                  {createType === "email" ? "[email]" : "email"}
                </button>
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  --name
                </label>
                <Input
                  placeholder="channel name"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  required
                />
              </div>

              {createType === "webhook" ? (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    --url
                  </label>
                  <Input
                    type="url"
                    placeholder="https://hooks.example.com/..."
                    value={createUrl}
                    onChange={(e) => setCreateUrl(e.target.value)}
                    required
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    --recipients (comma-separated)
                  </label>
                  <Input
                    placeholder="user@example.com, admin@example.com"
                    value={createRecipients}
                    onChange={(e) => setCreateRecipients(e.target.value)}
                    required
                  />
                </div>
              )}

              <Button type="submit" disabled={createLoading}>
                {createLoading ? "> creating..." : "$ create"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Content */}
      <div className="min-h-[200px]">
        {/* Loading */}
        {(showLoading || loading) && (
          <div
            className={
              showLoading
                ? "py-16 text-center"
                : "py-16 text-center invisible"
            }
          >
            <p className="text-sm text-primary">
              {">"} loading channels...
              <span className="ml-1 animate-pulse">_</span>
            </p>
          </div>
        )}

        {/* Error */}
        {!showLoading && !loading && error && (
          <div className="py-16 text-center">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 text-xs"
              onClick={fetchChannels}
            >
              $ retry
            </Button>
          </div>
        )}

        {/* Empty */}
        {!showLoading && !loading && !error && channels.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {">"} no channels configured. create one to receive
              notifications.
            </p>
          </div>
        )}

        {/* Channel list */}
        {!showLoading && !loading && !error && channels.length > 0 && (
          <div className="space-y-2 animate-content-ready">
            {channels.map((channel) => {
              const busy = actionLoading[channel.id] ?? false;
              const testBusy = actionLoading[`test-${channel.id}`] ?? false;

              return (
                <Card key={channel.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">
                            {channel.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            [{channel.type}]
                          </span>
                          <span
                            className={cn(
                              "text-xs",
                              channel.enabled
                                ? "text-primary"
                                : "text-muted-foreground",
                            )}
                          >
                            {channel.enabled ? "[enabled]" : "[disabled]"}
                          </span>
                        </div>

                        <div className="mt-1 text-xs text-muted-foreground">
                          {channel.type === "webhook" && (
                            <span>
                              url:{" "}
                              {(channel.config.url as string) ?? "not set"}
                            </span>
                          )}
                          {channel.type === "email" && (
                            <span>
                              recipients:{" "}
                              {(
                                (channel.config.recipients as string[]) ?? []
                              ).join(", ") || "none"}
                            </span>
                          )}
                        </div>

                        <p className="mt-1 text-xs text-muted-foreground">
                          created{" "}
                          {new Date(channel.createdAt).toLocaleDateString()}
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 text-xs shrink-0">
                        <button
                          disabled={testBusy || !channel.enabled}
                          onClick={() => testChannel(channel)}
                          className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                        >
                          {testBusy ? "..." : "[test]"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => toggleEnabled(channel)}
                          className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                        >
                          {busy
                            ? "..."
                            : channel.enabled
                              ? "[disable]"
                              : "[enable]"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => deleteChannel(channel)}
                          className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        >
                          [delete]
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
