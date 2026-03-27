"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types ----------------------------------------------------------- */

interface MonitoredImage {
  id?: string;
  name: string;
  registry: string;
  tagPatterns: string[];
  ignorePatterns?: string[];
  pollIntervalSeconds: number;
  lastPolledAt: string | null;
  lastEvent?: string | null;
  verificationStatus?: string;
  tagCount?: number;
  jobId?: string;
  githubRepo?: string | null;
  enabled?: boolean;
}

interface ImagesResponse {
  data: MonitoredImage[];
  message?: string;
}

/* -- helpers --------------------------------------------------------- */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function verificationBadge(status: string | undefined) {
  switch (status) {
    case "verified":
      return <span className="text-primary">[verified]</span>;
    case "unsigned":
      return <span className="text-warning">[unsigned]</span>;
    case "invalid":
      return <span className="text-destructive">[invalid]</span>;
    default:
      return <span className="text-muted-foreground">[pending]</span>;
  }
}

/* -- edit panel ------------------------------------------------------ */

interface EditPanelProps {
  image: MonitoredImage;
  onClose: () => void;
  onSaved: (updated: MonitoredImage) => void;
}

function EditPanel({ image, onClose, onSaved }: EditPanelProps) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const [tagWatch, setTagWatch] = useState(
    (image.tagPatterns ?? []).join(", "),
  );
  const [tagIgnore, setTagIgnore] = useState(
    (image.ignorePatterns ?? []).join(", "),
  );
  const [pollInterval, setPollInterval] = useState(
    String(image.pollIntervalSeconds ?? 300),
  );
  const [githubRepo, setGithubRepo] = useState(image.githubRepo ?? "");
  const [enabled, setEnabled] = useState(image.enabled !== false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!image.id) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ data: MonitoredImage }>(
        `/modules/registry/images/${image.id}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tagWatchPatterns: tagWatch
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            tagIgnorePatterns: tagIgnore
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            pollIntervalSeconds: Number(pollInterval),
            githubRepo: githubRepo.trim() || null,
            enabled,
          }),
        },
      );
      onSaved(res.data);
      toast(`Saved changes for ${image.name}.`);
      onClose();
    } catch (err) {
      toast(
        err instanceof Error ? `Failed: ${err.message}` : "Failed to save",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="col-span-full border-t border-border bg-muted/20 px-3 py-3">
      <p className="mb-3 text-xs text-muted-foreground">
        $ registry images edit --id {image.id ?? image.name}
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              tag watch (comma-separated)
            </label>
            <Input
              value={tagWatch}
              onChange={(e) => setTagWatch(e.target.value)}
              placeholder="*, v*, latest"
              className="h-8 text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              tag ignore (comma-separated)
            </label>
            <Input
              value={tagIgnore}
              onChange={(e) => setTagIgnore(e.target.value)}
              placeholder="*-rc, *-alpha"
              className="h-8 text-xs"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              poll interval (seconds, min 60)
            </label>
            <Input
              type="number"
              min={60}
              value={pollInterval}
              onChange={(e) => setPollInterval(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              github repo (e.g. org/repo)
            </label>
            <Input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="org/repo"
              className="h-8 text-xs"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">enabled</label>
          <div className="flex gap-3 text-xs">
            {(["true", "false"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setEnabled(opt === "true")}
                className={cn(
                  "transition-colors",
                  (enabled && opt === "true") || (!enabled && opt === "false")
                    ? "text-foreground"
                    : "text-muted-foreground/60 hover:text-foreground",
                )}
              >
                {(enabled && opt === "true") || (!enabled && opt === "false")
                  ? `[${opt}]`
                  : opt}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "> saving..." : "$ save changes"}
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            [cancel]
          </button>
        </div>
      </form>
    </div>
  );
}

/* -- page ------------------------------------------------------------ */

export default function ImagesPage() {
  const [images, setImages] = useState<MonitoredImage[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const { toast, toasts, dismiss } = useToast();

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createTags, setCreateTags] = useState("*");
  const [createRegistry, setCreateRegistry] = useState("docker_hub");
  const [createPollInterval, setCreatePollInterval] = useState("300");
  const [createLoading, setCreateLoading] = useState(false);

  // Edit panel
  const [editingId, setEditingId] = useState<string | null>(null);

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

  const fetchImages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ImagesResponse>(
        "/modules/registry/images",
        { credentials: "include" },
      );
      setImages(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load images");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchImages();
  }, [fetchImages]);

  /* -- create image -------------------------------------------------- */

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateLoading(true);
    try {
      const tagPatterns = createTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const res = await apiFetch<{ data: MonitoredImage }>(
        "/modules/registry/images",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: createName,
            tagPatterns,
            pollIntervalSeconds: Number(createPollInterval),
          }),
        },
      );

      setImages((prev) => [res.data, ...prev]);
      setShowCreate(false);
      setCreateName("");
      setCreateTags("*");
      setCreatePollInterval("300");
      toast("Image added. Initial poll queued.");
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to add image",
      );
    } finally {
      setCreateLoading(false);
    }
  }

  /* -- poll now ------------------------------------------------------ */

  async function pollNow(image: MonitoredImage) {
    const key = `poll-${image.name}`;
    setActionLoading((prev) => ({ ...prev, [key]: true }));
    try {
      await apiFetch("/modules/registry/images", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: image.name,
          tagPatterns: image.tagPatterns,
          pollIntervalSeconds: image.pollIntervalSeconds,
        }),
      });
      toast(`Poll queued for ${image.name}.`);
    } catch (err) {
      toast(
        err instanceof Error ? `Failed: ${err.message}` : "Poll failed",
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  /* -- remove image -------------------------------------------------- */

  async function removeImage(image: MonitoredImage) {
    const confirmed = await confirm(
      "Remove Image",
      `Stop monitoring "${image.name}"? Existing events will be preserved.`,
    );
    if (!confirmed) return;
    const key = `remove-${image.name}`;
    setActionLoading((prev) => ({ ...prev, [key]: true }));
    try {
      if (image.id) {
        await apiFetch(`/modules/registry/images/${image.id}`, {
          method: "DELETE",
          credentials: "include",
        });
      }
      setImages((prev) => prev.filter((i) => i.name !== image.name));
      toast(`Stopped monitoring ${image.name}.`);
    } catch (err) {
      toast(
        err instanceof Error ? `Failed: ${err.message}` : "Failed to remove",
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  /* -- edit saved ---------------------------------------------------- */

  function handleEditSaved(updated: MonitoredImage) {
    setImages((prev) =>
      prev.map((img) =>
        img.id && img.id === updated.id ? { ...img, ...updated } : img,
      ),
    );
  }

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6 font-mono">
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
            $ registry images ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} monitored Docker images
          </p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "[cancel]" : "+ Add Image"}
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              $ registry images add
            </p>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  name (e.g. library/nginx, ghcr.io/org/app)
                </label>
                <Input
                  placeholder="library/nginx"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  required
                  className="h-8 text-xs"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  tags (comma-separated glob patterns)
                </label>
                <Input
                  placeholder="*, latest, v*"
                  value={createTags}
                  onChange={(e) => setCreateTags(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>

              <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">registry</span>
                {["docker_hub"].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setCreateRegistry(r)}
                    className={cn(
                      "transition-colors",
                      createRegistry === r
                        ? "text-foreground"
                        : "text-muted-foreground/60 hover:text-foreground",
                    )}
                  >
                    {createRegistry === r ? `[${r}]` : r}
                  </button>
                ))}
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  poll interval (seconds, min 60)
                </label>
                <Input
                  type="number"
                  min={60}
                  placeholder="300"
                  value={createPollInterval}
                  onChange={(e) => setCreatePollInterval(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>

              <Button type="submit" disabled={createLoading}>
                {createLoading ? "> adding..." : "$ add image"}
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
              {">"} loading images...
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
              onClick={fetchImages}
            >
              $ retry
            </Button>
          </div>
        )}

        {/* Empty */}
        {!showLoading && !loading && !error && images.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no monitored images
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                add a Docker image to start monitoring tag and digest changes
              </p>
              <Button className="mt-4" onClick={() => setShowCreate(true)}>
                + Add Image
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Image list */}
        {!showLoading && !loading && !error && images.length > 0 && (
          <div className="animate-content-ready">
            {/* Header row */}
            <div className="grid grid-cols-[2fr_80px_80px_100px_100px_1fr] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Image</span>
              <span>Tags</span>
              <span>Registry</span>
              <span>Last Event</span>
              <span>Verification</span>
              <span className="text-right">Actions</span>
            </div>

            <p className="px-3 pt-2 text-xs text-muted-foreground">
              {images.length} image{images.length !== 1 ? "s" : ""} monitored
            </p>

            {/* Rows */}
            {images.map((image) => {
              const pollBusy = actionLoading[`poll-${image.name}`] ?? false;
              const removeBusy = actionLoading[`remove-${image.name}`] ?? false;
              const isEditing = editingId === (image.id ?? image.name);

              return (
                <div key={image.name}>
                  <div className="group grid grid-cols-[2fr_80px_80px_100px_100px_1fr] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30">
                    <Link
                      href={`/registry/images/${image.id ?? image.name}`}
                      className="truncate font-medium text-foreground group-hover:text-primary transition-colors"
                    >
                      {image.name}
                    </Link>

                    <span className="text-xs text-muted-foreground">
                      {image.tagCount ?? image.tagPatterns.length}
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {image.registry}
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {formatDate(image.lastEvent ?? image.lastPolledAt)}
                    </span>

                    <span className="text-xs">
                      {verificationBadge(image.verificationStatus)}
                    </span>

                    <span className="flex items-center justify-end gap-2 text-xs">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(
                            isEditing ? null : (image.id ?? image.name),
                          );
                        }}
                        className={cn(
                          "transition-colors",
                          isEditing
                            ? "text-primary"
                            : "text-muted-foreground hover:text-primary",
                        )}
                      >
                        [edit]
                      </button>
                      <button
                        disabled={pollBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          pollNow(image);
                        }}
                        className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                      >
                        {pollBusy ? "..." : "[poll]"}
                      </button>
                      <button
                        disabled={removeBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeImage(image);
                        }}
                        className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                      >
                        {removeBusy ? "..." : "[remove]"}
                      </button>
                    </span>
                  </div>

                  {isEditing && (
                    <EditPanel
                      image={image}
                      onClose={() => setEditingId(null)}
                      onSaved={handleEditSaved}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
