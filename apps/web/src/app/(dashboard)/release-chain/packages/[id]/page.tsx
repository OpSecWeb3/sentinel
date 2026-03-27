"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

function truncateIntegrity(digest: string | null): string {
  if (!digest) return "--";
  // npm uses integrity hashes like sha512-<base64> — show first 16 chars after prefix
  const dashIdx = digest.indexOf("-");
  const clean = dashIdx !== -1 ? digest.slice(dashIdx + 1) : digest;
  return clean.slice(0, 16);
}

const versionStatusColor: Record<string, string> = {
  active: "text-primary",
  gone: "text-muted-foreground",
  untracked: "text-muted-foreground/60",
};

const eventTypeLabels: Record<string, string> = {
  "release-chain.docker.digest_change": "digest_change",
  "release-chain.docker.new_tag": "new_tag",
  "release-chain.docker.tag_removed": "tag_removed",
  "release-chain.npm.version_published": "version_published",
  "release-chain.npm.version_deprecated": "version_deprecated",
  "release-chain.npm.version_unpublished": "version_unpublished",
  "release-chain.npm.maintainer_changed": "maintainer_changed",
  "release-chain.npm.dist_tag_updated": "dist_tag_updated",
  "release-chain.verification.signature_missing": "signature_missing",
  "release-chain.verification.provenance_missing": "provenance_missing",
  "release-chain.verification.signature_invalid": "signature_invalid",
  "release-chain.verification.provenance_invalid": "provenance_invalid",
  "release-chain.attribution.unattributed_change": "unattributed_change",
  "release-chain.attribution.attribution_mismatch": "attribution_mismatch",
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

function getShortEventType(type: string): string {
  return eventTypeLabels[type] ?? type.split(".").pop() ?? type;
}

/* -- page ------------------------------------------------------------ */

export default function PackageDetailPage() {
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
  const { toast } = useToast();

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DetailResponse>(
        `/modules/release-chain/packages/${id}`,
        { credentials: "include" },
      );
      setArtifact(res.data.artifact);
      setVersions(res.data.versions);
      setEvents(res.data.recentEvents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load package detail");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  /* -- poll now ------------------------------------------------------ */

  async function pollNow() {
    setPollLoading(true);
    try {
      await apiFetch(`/modules/release-chain/packages/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      toast("Poll queued. Results will appear shortly.");
      setTimeout(() => fetchDetail(), 2000);
    } catch (err) {
      toast(err instanceof Error ? `Failed: ${err.message}` : "Poll failed");
    } finally {
      setPollLoading(false);
    }
  }

  /* -- copy integrity hash ------------------------------------------ */

  async function copyHash(hash: string, key: string) {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast("Failed to copy to clipboard");
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
        <p className="text-sm text-destructive">[ERR] {error ?? "Package not found"}</p>
        <Button variant="outline" size="sm" onClick={fetchDetail}>
          $ retry
        </Button>
      </div>
    );
  }

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6 font-mono">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            <Link
              href="/release-chain/packages"
              className="hover:text-primary transition-colors"
            >
              release-chain / packages
            </Link>
            {" / "}
            <span className="text-foreground">{artifact.id.slice(0, 8)}</span>
          </p>
          <h1 className="text-lg text-primary text-glow">
            $ release-chain packages inspect
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
              <p className="text-muted-foreground">--watch-dist-tags</p>
              <p className="mt-0.5 text-foreground">
                {artifact.tagWatchPatterns.length > 0
                  ? artifact.tagWatchPatterns.join(", ")
                  : <span className="text-muted-foreground">none</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">--ignore-versions</p>
              <p className="mt-0.5 text-foreground">
                {artifact.tagIgnorePatterns.length > 0
                  ? artifact.tagIgnorePatterns.join(", ")
                  : <span className="text-muted-foreground">none</span>}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">--poll-interval</p>
              <p className="mt-0.5 text-foreground">
                {formatInterval(artifact.pollIntervalSeconds)}
                <span className="ml-1 text-muted-foreground">
                  ({artifact.pollIntervalSeconds}s)
                </span>
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">--last-polled</p>
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
                <p className="text-muted-foreground">--github-repo</p>
                <p className="mt-0.5 text-foreground">{artifact.githubRepo}</p>
              </div>
            )}
            {artifact.webhookUrl && (
              <div>
                <p className="text-muted-foreground">--webhook-url</p>
                <p className="mt-0.5 text-foreground truncate">{artifact.webhookUrl}</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">--added</p>
              <p className="mt-0.5 text-foreground">
                {new Date(artifact.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Versions table */}
      <div>
        <p className="mb-3 text-xs text-muted-foreground">
          $ release-chain packages versions ls
          <span className="ml-2 text-foreground">
            ({versions.length} version{versions.length !== 1 ? "s" : ""})
          </span>
        </p>

        {versions.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-xs text-muted-foreground">
                {">"} no tracked versions yet — trigger a poll to discover versions
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_180px_80px_120px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Version</span>
                <span>Integrity</span>
                <span>Status</span>
                <span>Changed</span>
              </div>

              {versions.map((v) => {
                const hashKey = `v-${v.id}`;
                const isCopied = copiedId === hashKey;
                const shortHash = truncateIntegrity(v.currentDigest);

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
                        {shortHash}
                      </span>
                      {v.currentDigest && (
                        <button
                          onClick={() => copyHash(v.currentDigest!, hashKey)}
                          className="text-muted-foreground/50 hover:text-primary transition-colors"
                          title="Copy full integrity hash"
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
          $ release-chain packages events ls --limit 20
          <span className="ml-2 text-foreground">
            ({events.length} event{events.length !== 1 ? "s" : ""})
          </span>
        </p>

        {events.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-xs text-muted-foreground">
                {">"} no events recorded for this package
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[700px]">
              {/* Header row */}
              <div className="grid grid-cols-[140px_100px_80px_140px_100px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Event</span>
                <span>Version</span>
                <span>Source</span>
                <span>Hash Change</span>
                <span>Time</span>
              </div>

              {events.map((ev) => {
                const shortType = getShortEventType(ev.artifactEventType);
                const color =
                  eventTypeColor[shortType] ?? "text-muted-foreground";
                const isExpanded = expandedEventId === ev.id;
                const oldShort = truncateIntegrity(ev.oldDigest);
                const newShort = truncateIntegrity(ev.newDigest);
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
                              <span className="text-muted-foreground">publisher: </span>
                              <span className="text-foreground">{ev.pusher}</span>
                            </div>
                          )}
                        </div>

                        {(ev.oldDigest || ev.newDigest) && (
                          <div className="space-y-1">
                            {ev.oldDigest && (
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-24">old integrity:</span>
                                <span className="font-mono text-xs text-foreground break-all">
                                  {ev.oldDigest}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyHash(ev.oldDigest!, oldKey);
                                  }}
                                  className="shrink-0 text-muted-foreground/50 hover:text-primary transition-colors"
                                >
                                  {copiedId === oldKey ? "[copied]" : "[copy]"}
                                </button>
                              </div>
                            )}
                            {ev.newDigest && (
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground w-24">new integrity:</span>
                                <span className="font-mono text-xs text-foreground break-all">
                                  {ev.newDigest}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyHash(ev.newDigest!, newKey);
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
    </div>
  );
}
