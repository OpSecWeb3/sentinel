"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types ----------------------------------------------------------- */

interface Artifact {
  id: string;
  name: string;
  registry: string;
  artifactType: string;
  enabled: boolean;
  tagWatchPatterns: string[];
  tagIgnorePatterns: string[];
  pollIntervalSeconds: number;
  lastPolledAt: string | null;
  githubRepo: string | null;
  webhookUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  hasCredentials: boolean;
}

interface ArtifactVersion {
  id: string;
  version: string;
  currentDigest: string | null;
  status: "active" | "gone" | "untracked";
  digestChangedAt: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface ArtifactEvent {
  id: string;
  artifactEventType: string;
  version: string;
  oldDigest: string | null;
  newDigest: string | null;
  pusher: string | null;
  source: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface DetailResponse {
  data: {
    artifact: Artifact;
    versions: ArtifactVersion[];
    recentEvents: ArtifactEvent[];
  };
}

interface Detection {
  id: string;
  name: string;
  severity: string;
  status: "active" | "paused";
  templateId: string | null;
  createdAt: string;
}

interface DetectionsResponse {
  data: Detection[];
}

/* -- helpers --------------------------------------------------------- */

function formatRelative(iso: string | null | undefined): string {
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

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function truncateDigest(digest: string | null): string {
  if (!digest) return "--";
  // Strip sha256: prefix for display then truncate
  const clean = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  return clean.slice(0, 16);
}

const versionStatusColor: Record<string, string> = {
  active: "text-primary",
  gone: "text-muted-foreground",
  untracked: "text-muted-foreground/60",
};

const eventTypeLabels: Record<string, string> = {
  "registry.docker.digest_change": "digest_change",
  "registry.docker.new_tag": "new_tag",
  "registry.docker.tag_removed": "tag_removed",
  "registry.npm.version_published": "version_published",
  "registry.npm.version_deprecated": "version_deprecated",
  "registry.npm.version_unpublished": "version_unpublished",
  "registry.npm.maintainer_changed": "maintainer_changed",
  "registry.npm.dist_tag_updated": "dist_tag_updated",
  "registry.verification.signature_missing": "signature_missing",
  "registry.verification.provenance_missing": "provenance_missing",
  "registry.verification.signature_invalid": "signature_invalid",
  "registry.verification.provenance_invalid": "provenance_invalid",
  "registry.attribution.unattributed_change": "unattributed_change",
  "registry.attribution.attribution_mismatch": "attribution_mismatch",
};

const eventTypeColor: Record<string, string> = {
  digest_change: "text-warning",
  new_tag: "text-primary",
  tag_removed: "text-destructive",
  version_published: "text-primary",
  version_deprecated: "text-warning",
  version_unpublished: "text-destructive",
  maintainer_changed: "text-warning",
  dist_tag_updated: "text-muted-foreground",
  signature_missing: "text-destructive",
  provenance_missing: "text-destructive",
  signature_invalid: "text-destructive",
  provenance_invalid: "text-destructive",
  unattributed_change: "text-warning",
  attribution_mismatch: "text-warning",
};

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-destructive",
  medium: "text-warning",
  low: "text-muted-foreground",
  info: "text-muted-foreground",
};

function getShortEventType(type: string): string {
  return eventTypeLabels[type] ?? type.split(".").pop() ?? type;
}

/* -- page ------------------------------------------------------------ */

export default function ImageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [events, setEvents] = useState<ArtifactEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [pollLoading, setPollLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const { toast, toasts, dismiss } = useToast();

  // Credentials state
  const [dockerUsername, setDockerUsername] = useState("");
  const [dockerToken, setDockerToken] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsClearing, setCredsClearing] = useState(false);

  // Detections state
  const [detections, setDetections] = useState<Detection[]>([]);
  const [detectionsLoading, setDetectionsLoading] = useState(true);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DetailResponse>(
        `/modules/registry/images/${id}`,
        { credentials: "include" },
      );
      setArtifact(res.data.artifact);
      setVersions(res.data.versions);
      setEvents(res.data.recentEvents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load image detail");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchDetections = useCallback(async () => {
    setDetectionsLoading(true);
    try {
      const res = await apiFetch<DetectionsResponse>(
        `/api/detections?moduleId=registry&limit=50`,
        { credentials: "include" },
      );
      setDetections(res.data);
    } catch {
      setDetections([]);
    } finally {
      setDetectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.allSettled([fetchDetail(), fetchDetections()]);
  }, [fetchDetail, fetchDetections]);

  /* -- poll now ------------------------------------------------------ */

  async function pollNow() {
    setPollLoading(true);
    try {
      await apiFetch(`/modules/registry/images/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      toast("Poll queued. Results will appear shortly.");
      // Refresh after short delay to pick up any fast results
      setTimeout(() => fetchDetail(), 2000);
    } catch (err) {
      toast(err instanceof Error ? `Failed: ${err.message}` : "Poll failed");
    } finally {
      setPollLoading(false);
    }
  }

  /* -- copy digest --------------------------------------------------- */

  async function copyDigest(digest: string, key: string) {
    try {
      await navigator.clipboard.writeText(digest);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast("Failed to copy to clipboard");
    }
  }

  /* -- credentials --------------------------------------------------- */

  async function saveCredentials() {
    setCredsSaving(true);
    try {
      await apiFetch(`/modules/registry/images/${id}/credentials`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dockerUsername, dockerToken }),
      });
      toast("Credentials saved.");
      setDockerUsername("");
      setDockerToken("");
      fetchDetail();
    } catch (err) {
      toast(err instanceof Error ? `Failed: ${err.message}` : "Failed to save credentials");
    } finally {
      setCredsSaving(false);
    }
  }

  async function clearCredentials() {
    if (!confirm("Clear registry credentials for this image?")) return;
    setCredsClearing(true);
    try {
      await apiFetch(`/modules/registry/images/${id}/credentials`, {
        method: "DELETE",
        credentials: "include",
      });
      toast("Credentials cleared.");
      fetchDetail();
    } catch (err) {
      toast(err instanceof Error ? `Failed: ${err.message}` : "Failed to clear credentials");
    } finally {
      setCredsClearing(false);
    }
  }

  /* -- loading ------------------------------------------------------- */

  if (showLoading || loading) {
    return (
      <div className="space-y-4 font-mono animate-pulse">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="h-6 w-64 rounded bg-muted" />
        <div className="h-28 rounded bg-muted" />
        <div className="h-40 rounded bg-muted" />
      </div>
    );
  }

  /* -- error --------------------------------------------------------- */

  if (error || !artifact) {
    return (
      <div className="font-mono space-y-3">
        <p className="text-sm text-destructive">[ERR] {error ?? "Image not found"}</p>
        <Button variant="outline" size="sm" onClick={fetchDetail}>
          $ retry
        </Button>
      </div>
    );
  }

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6 font-mono">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            <Link
              href="/registry/images"
              className="hover:text-primary transition-colors"
            >
              registry / images
            </Link>
            {" / "}
            <span className="text-foreground">{artifact.id.slice(0, 8)}</span>
          </p>
          <h1 className="text-lg text-primary text-glow">
            $ registry images inspect
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} {artifact.name}
          </p>

          {/* Badges */}
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
              {artifact.registry}
            </span>
            {artifact.enabled ? (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                [enabled]
              </span>
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                [disabled]
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            disabled={pollLoading}
            onClick={pollNow}
            className="text-xs"
          >
            {pollLoading ? "> polling..." : "$ poll now"}
          </Button>
        </div>
      </div>

      {/* Config card */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground mb-2">$ cat config</p>
          <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground">watch patterns</p>
              <p className="mt-0.5 text-foreground">
                {artifact.tagWatchPatterns.length > 0
                  ? artifact.tagWatchPatterns.join(", ")
                  : <span className="text-muted-foreground">none</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">ignore patterns</p>
              <p className="mt-0.5 text-foreground">
                {artifact.tagIgnorePatterns.length > 0
                  ? artifact.tagIgnorePatterns.join(", ")
                  : <span className="text-muted-foreground">none</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">poll interval</p>
              <p className="mt-0.5 text-foreground">
                {formatInterval(artifact.pollIntervalSeconds)}
                <span className="ml-1 text-muted-foreground">
                  ({artifact.pollIntervalSeconds}s)
                </span>
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">last polled</p>
              <p className="mt-0.5 text-foreground">
                {formatRelative(artifact.lastPolledAt)}
                {artifact.lastPolledAt && (
                  <span className="ml-1 text-muted-foreground">
                    ({new Date(artifact.lastPolledAt).toLocaleString()})
                  </span>
                )}
              </p>
            </div>
            {artifact.githubRepo && (
              <div>
                <p className="text-muted-foreground">github repo</p>
                <p className="mt-0.5 text-foreground">{artifact.githubRepo}</p>
              </div>
            )}
            {artifact.webhookUrl && (
              <div>
                <p className="text-muted-foreground">webhook url</p>
                <p className="mt-0.5 text-foreground truncate">{artifact.webhookUrl}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">added</p>
              <p className="mt-0.5 text-foreground">
                {new Date(artifact.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Registry Credentials card */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">$ cat credentials</p>
            <span
              className={cn(
                "text-xs font-mono",
                artifact.hasCredentials ? "text-primary" : "text-muted-foreground",
              )}
            >
              {artifact.hasCredentials ? "[credentials: set]" : "[credentials: none]"}
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="docker-username">
                docker username
              </label>
              <Input
                id="docker-username"
                type="text"
                value={dockerUsername}
                onChange={(e) => setDockerUsername(e.target.value)}
                placeholder="Docker Hub username"
                autoComplete="username"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="docker-token">
                docker token
              </label>
              <Input
                id="docker-token"
                type="password"
                value={dockerToken}
                onChange={(e) => setDockerToken(e.target.value)}
                placeholder="Docker Hub token or password"
                autoComplete="new-password"
                className="h-8 text-xs"
              />
            </div>
            <p className="text-muted-foreground/60">
              {">"} Required for private Docker Hub repositories
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={credsSaving || !dockerUsername || !dockerToken}
              onClick={saveCredentials}
              className="text-xs"
            >
              {credsSaving ? "> saving..." : "$ save credentials"}
            </Button>
            {artifact.hasCredentials && (
              <Button
                size="sm"
                variant="outline"
                disabled={credsClearing}
                onClick={clearCredentials}
                className="text-xs text-destructive hover:text-destructive"
              >
                {credsClearing ? "> clearing..." : "$ clear credentials"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Versions / Tags table */}
      <div>
        <p className="mb-3 text-xs text-muted-foreground">
          $ registry images tags ls
          <span className="ml-2 text-foreground">
            ({versions.length} tag{versions.length !== 1 ? "s" : ""})
          </span>
        </p>

        {versions.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-xs text-muted-foreground">
                {">"} no tracked tags yet — trigger a poll to discover tags
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_180px_80px_120px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Tag</span>
                <span>Digest</span>
                <span>Status</span>
                <span>Changed</span>
              </div>

              {versions.map((v) => {
                const digestKey = `v-${v.id}`;
                const isCopied = copiedId === digestKey;
                const shortDigest = truncateDigest(v.currentDigest);

                return (
                  <div
                    key={v.id}
                    className="grid grid-cols-[1fr_180px_80px_120px] items-center gap-x-3 border border-transparent px-3 py-2 text-xs transition-colors hover:border-border hover:bg-muted/30"
                  >
                    <span className="truncate text-foreground font-mono">
                      {v.version}
                    </span>

                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-muted-foreground">
                        {shortDigest}
                      </span>
                      {v.currentDigest && (
                        <button
                          onClick={() => copyDigest(v.currentDigest!, digestKey)}
                          className="text-muted-foreground/50 hover:text-primary transition-colors"
                          title="Copy full digest"
                        >
                          {isCopied ? "[copied]" : "[copy]"}
                        </button>
                      )}
                    </span>

                    <span
                      className={cn(
                        "font-mono",
                        versionStatusColor[v.status] ?? "text-muted-foreground",
                      )}
                    >
                      [{v.status}]
                    </span>

                    <span className="text-muted-foreground">
                      {formatRelative(v.digestChangedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Recent Events */}
      <div>
        <p className="mb-3 text-xs text-muted-foreground">
          $ registry images events ls --limit 20
          <span className="ml-2 text-foreground">
            ({events.length} event{events.length !== 1 ? "s" : ""})
          </span>
        </p>

        {events.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-xs text-muted-foreground">
                {">"} no events recorded for this image
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[700px]">
              {/* Header row */}
              <div className="grid grid-cols-[140px_100px_80px_140px_100px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Event</span>
                <span>Tag</span>
                <span>Source</span>
                <span>Digest Change</span>
                <span>Time</span>
              </div>

              {events.map((ev) => {
                const shortType = getShortEventType(ev.artifactEventType);
                const color =
                  eventTypeColor[shortType] ?? "text-muted-foreground";
                const isExpanded = expandedEventId === ev.id;
                const oldShort = truncateDigest(ev.oldDigest);
                const newShort = truncateDigest(ev.newDigest);
                const oldKey = `ev-old-${ev.id}`;
                const newKey = `ev-new-${ev.id}`;

                return (
                  <div key={ev.id}>
                    <div
                      className="group grid grid-cols-[140px_100px_80px_140px_100px] items-center gap-x-3 border border-transparent px-3 py-2 text-xs transition-colors hover:border-border hover:bg-muted/30 cursor-pointer"
                      onClick={() =>
                        setExpandedEventId(isExpanded ? null : ev.id)
                      }
                    >
                      <span className={cn("font-mono truncate", color)}>
                        {shortType}
                      </span>

                      <span className="font-mono text-foreground truncate">
                        {ev.version || "--"}
                      </span>

                      <span className="text-muted-foreground">{ev.source}</span>

                      <span className="flex items-center gap-1 font-mono text-muted-foreground">
                        {ev.oldDigest || ev.newDigest ? (
                          <>
                            <span>{oldShort}</span>
                            <span className="text-muted-foreground/40">→</span>
                            <span>{newShort}</span>
                          </>
                        ) : (
                          <span>--</span>
                        )}
                      </span>

                      <span className="text-muted-foreground">
                        {formatRelative(ev.createdAt)}
                      </span>
                    </div>

                    {/* Expanded row */}
                    {isExpanded && (
                      <div className="border-x border-b border-border bg-muted/20 px-4 py-3 text-xs space-y-3">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <div>
                            <span className="text-muted-foreground">id: </span>
                            <span className="font-mono text-foreground">{ev.id}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">event: </span>
                            <span className="font-mono text-foreground">{ev.artifactEventType}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">timestamp: </span>
                            <span className="text-foreground">
                              {new Date(ev.createdAt).toLocaleString()}
                            </span>
                          </div>
                          {ev.pusher && (
                            <div>
                              <span className="text-muted-foreground">pusher: </span>
                              <span className="text-foreground">{ev.pusher}</span>
                            </div>
                          )}
                        </div>

                        {(ev.oldDigest || ev.newDigest) && (
                          <div className="space-y-1">
                            {ev.oldDigest && (
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-20">old digest:</span>
                                <span className="font-mono text-xs text-foreground break-all">
                                  {ev.oldDigest}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyDigest(ev.oldDigest!, oldKey);
                                  }}
                                  className="shrink-0 text-muted-foreground/50 hover:text-primary transition-colors"
                                >
                                  {copiedId === oldKey ? "[copied]" : "[copy]"}
                                </button>
                              </div>
                            )}
                            {ev.newDigest && (
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-20">new digest:</span>
                                <span className="font-mono text-xs text-foreground break-all">
                                  {ev.newDigest}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyDigest(ev.newDigest!, newKey);
                                  }}
                                  className="shrink-0 text-muted-foreground/50 hover:text-primary transition-colors"
                                >
                                  {copiedId === newKey ? "[copied]" : "[copy]"}
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                          <div>
                            <p className="mb-1 text-muted-foreground">metadata:</p>
                            <pre className="rounded border border-border bg-background p-2 font-mono text-xs text-foreground overflow-x-auto">
                              {JSON.stringify(ev.metadata, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Detections */}
      <div>
        <p className="mb-3 text-xs text-muted-foreground">
          $ detections ls --module registry
          {!detectionsLoading && (
            <span className="ml-2 text-foreground">
              ({detections.length} detection{detections.length !== 1 ? "s" : ""})
            </span>
          )}
        </p>

        {detectionsLoading ? (
          <Card>
            <CardContent className="p-4 space-y-2 animate-pulse">
              <div className="h-3 w-48 rounded bg-muted" />
              <div className="h-3 w-64 rounded bg-muted" />
              <div className="h-3 w-40 rounded bg-muted" />
            </CardContent>
          </Card>
        ) : detections.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-2 py-6 px-4">
              <p className="text-xs text-muted-foreground">
                {">"} No detections configured — enable a template or create a detection
              </p>
              <Link
                href="/registry/templates"
                className="text-xs text-primary hover:underline"
              >
                {">"} browse registry templates
              </Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              {detections.map((det, idx) => (
                <Link
                  key={det.id}
                  href={`/detections/${det.id}`}
                  className={cn(
                    "flex items-center justify-between gap-3 px-4 py-2.5 text-xs transition-colors hover:bg-muted/30",
                    idx !== detections.length - 1 && "border-b border-border",
                  )}
                >
                  <span className="truncate text-foreground font-mono">{det.name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span
                      className={cn(
                        "font-mono",
                        severityColor[det.severity.toLowerCase()] ?? "text-muted-foreground",
                      )}
                    >
                      [{det.severity.toLowerCase()}]
                    </span>
                    <span
                      className={cn(
                        "font-mono",
                        det.status === "active" ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      [{det.status}]
                    </span>
                  </span>
                </Link>
              ))}
              <div className="border-t border-border px-4 py-2.5 space-y-1.5">
                <Link
                  href="/detections/new?moduleId=registry"
                  className="block text-xs text-primary hover:underline"
                >
                  + new detection
                </Link>
                <p className="text-xs text-muted-foreground/60">
                  {">"} These detections evaluate all registry events across your monitored artifacts
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {!detectionsLoading && detections.length > 0 && (
          <div className="mt-2 px-1">
            <Link
              href="/detections/new?moduleId=registry"
              className="text-xs text-primary hover:underline"
            >
              + new detection
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
