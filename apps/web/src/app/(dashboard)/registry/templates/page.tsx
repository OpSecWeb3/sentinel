"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types ----------------------------------------------------------- */

interface DetectionTemplate {
  slug: string;
  name: string;
  description: string;
  category: string;
  severity: string;
  ruleCount: number;
}

interface EventType {
  type: string;
  label: string;
  description: string;
}

interface MonitoredArtifact {
  id?: string;
  name: string;
  registry: string;
}

/* -- helpers --------------------------------------------------------- */

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const categoryLabel: Record<string, string> = {
  "container-security": "Container Security",
  "supply-chain": "Supply Chain",
  "package-security": "Package Security",
  comprehensive: "Comprehensive",
};

/* -- enable modal ---------------------------------------------------- */

interface EnableModalProps {
  template: DetectionTemplate;
  onClose: () => void;
  onEnabled: (slug: string, detectionName: string) => void;
}

function EnableModal({ template, onClose, onEnabled }: EnableModalProps) {
  const { toast } = useToast();

  const [artifacts, setArtifacts] = useState<MonitoredArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(true);
  const [artifactsFailed, setArtifactsFailed] = useState(false);

  const [selectedArtifactId, setSelectedArtifactId] = useState<string>("");
  const [detectionName, setDetectionName] = useState(template.name);
  const [submitting, setSubmitting] = useState(false);

  // Keep name in sync with artifact selection unless user has edited it
  const userEditedName = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchArtifacts() {
      setArtifactsLoading(true);
      setArtifactsFailed(false);
      try {
        const [imagesRes, packagesRes] = await Promise.allSettled([
          apiFetch<{ data: MonitoredArtifact[] }>(
            "/modules/registry/images",
            { credentials: "include" },
          ),
          apiFetch<{ data: MonitoredArtifact[] }>(
            "/modules/registry/packages",
            { credentials: "include" },
          ),
        ]);

        if (cancelled) return;

        const combined: MonitoredArtifact[] = [];
        if (imagesRes.status === "fulfilled") {
          combined.push(...imagesRes.value.data);
        }
        if (packagesRes.status === "fulfilled") {
          combined.push(...packagesRes.value.data);
        }

        if (
          imagesRes.status === "rejected" &&
          packagesRes.status === "rejected"
        ) {
          setArtifactsFailed(true);
        } else {
          setArtifacts(combined);
        }
      } catch {
        if (!cancelled) setArtifactsFailed(true);
      } finally {
        if (!cancelled) setArtifactsLoading(false);
      }
    }

    fetchArtifacts();
    return () => {
      cancelled = true;
    };
  }, []);

  // Update detection name when artifact changes (unless user customised it)
  useEffect(() => {
    if (userEditedName.current) return;
    if (selectedArtifactId === "") {
      setDetectionName(template.name);
    } else {
      const artifact = artifacts.find(
        (a) => (a.id ?? a.name) === selectedArtifactId,
      );
      if (artifact) {
        setDetectionName(`${template.name} — ${artifact.name}`);
      }
    }
  }, [selectedArtifactId, artifacts, template.name]);

  const selectedArtifact =
    selectedArtifactId !== ""
      ? (artifacts.find((a) => (a.id ?? a.name) === selectedArtifactId) ?? null)
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        moduleId: "registry",
        templateSlug: template.slug,
        name: detectionName.trim() || template.name,
      };

      if (selectedArtifact) {
        body.config = { artifactName: selectedArtifact.name };
      }

      await apiFetch("/api/detections/from-template", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      onEnabled(template.slug, body.name as string);
      toast(`Detection "${body.name}" enabled.`);
      onClose();
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to enable template",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-lg">
        <CardContent className="p-5">
          {/* Title */}
          <p className="mb-4 text-xs text-primary text-glow font-mono">
            $ enable: {template.name}
            <span className="ml-1 animate-pulse">_</span>
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Artifact scope */}
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                scope (optional)
              </label>

              {artifactsLoading ? (
                <div className="flex h-9 items-center rounded border border-border bg-muted/20 px-3">
                  <span className="text-xs text-muted-foreground">
                    {">"} loading artifacts...
                    <span className="ml-1 animate-pulse">_</span>
                  </span>
                </div>
              ) : artifactsFailed ? (
                <div className="flex h-9 items-center rounded border border-border bg-muted/20 px-3">
                  <span className="text-xs text-muted-foreground">
                    [no specific artifact — apply globally]
                  </span>
                </div>
              ) : (
                <Select
                  value={selectedArtifactId}
                  onValueChange={(v) => {
                    userEditedName.current = false;
                    setSelectedArtifactId(v);
                  }}
                  options={[
                    {
                      value: "",
                      label: "No specific artifact — apply globally",
                    },
                    ...artifacts.map((a) => ({
                      value: a.id ?? a.name,
                      label: `${a.name}${a.registry ? `  [${a.registry}]` : ""}`,
                    })),
                  ]}
                  className="w-full"
                />
              )}
            </div>

            {/* Detection name */}
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                name
              </label>
              <Input
                value={detectionName}
                onChange={(e) => {
                  userEditedName.current = true;
                  setDetectionName(e.target.value);
                }}
                placeholder={template.name}
                autoFocus={false}
                className="h-8 text-xs"
              />
            </div>

            {/* Scope hint */}
            <div className="rounded border border-border bg-muted/20 px-3 py-2">
              {selectedArtifact ? (
                <p className="text-xs text-muted-foreground">
                  {">"} This detection will apply to{" "}
                  <span className="text-primary">{selectedArtifact.name}</span>.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {">"} This detection will evaluate events from all monitored
                  Docker/npm artifacts in your org.
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                [cancel]
              </button>
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? "> enabling..." : "$ enable detection"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/* -- page ------------------------------------------------------------ */

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<DetectionTemplate[]>([]);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [enabledSlugs, setEnabledSlugs] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const { toast, toasts, dismiss } = useToast();

  // Modal state
  const [modalTemplate, setModalTemplate] =
    useState<DetectionTemplate | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventTypesRes, templatesRes] = await Promise.allSettled([
        apiFetch<{ data: EventType[] }>(
          "/modules/registry/event-types",
          { credentials: "include" },
        ),
        apiFetch<{ data: DetectionTemplate[] }>(
          "/modules/registry/templates",
          { credentials: "include" },
        ),
      ]);

      if (eventTypesRes.status === "fulfilled") {
        setEventTypes(eventTypesRes.value.data);
      }

      if (templatesRes.status === "fulfilled") {
        setTemplates(templatesRes.value.data);
      } else {
        // Templates may not have a dedicated endpoint yet; use hardcoded set
        setTemplates(getBuiltinTemplates());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* -- filter -------------------------------------------------------- */

  const categories = Array.from(new Set(templates.map((t) => t.category)));
  const filteredTemplates =
    categoryFilter === "all"
      ? templates
      : templates.filter((t) => t.category === categoryFilter);

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6 font-mono">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      {/* Enable modal */}
      {modalTemplate && (
        <EnableModal
          template={modalTemplate}
          onClose={() => setModalTemplate(null)}
          onEnabled={(slug) => {
            setEnabledSlugs((prev) => new Set([...prev, slug]));
            setModalTemplate(null);
          }}
        />
      )}

      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ registry templates ls
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} pre-built detection templates for supply chain security
        </p>
      </div>

      {/* Category filter */}
      {templates.length > 0 && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">category</span>
          <button
            onClick={() => setCategoryFilter("all")}
            className={cn(
              "transition-colors",
              categoryFilter === "all"
                ? "text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            {categoryFilter === "all" ? "[all]" : "all"}
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={cn(
                "transition-colors",
                categoryFilter === cat
                  ? "text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground",
              )}
            >
              {categoryFilter === cat ? `[${cat}]` : cat}
            </button>
          ))}
        </div>
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
              {">"} loading templates...
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
              onClick={fetchData}
            >
              $ retry
            </Button>
          </div>
        )}

        {/* Template cards */}
        {!showLoading && !loading && !error && (
          <div className="space-y-4 animate-content-ready">
            <p className="text-xs text-muted-foreground">
              {filteredTemplates.length} template
              {filteredTemplates.length !== 1 ? "s" : ""}
              {categoryFilter !== "all" ? ` in ${categoryFilter}` : ""}
            </p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTemplates.map((template) => {
                const enabled = enabledSlugs.has(template.slug);

                return (
                  <Card
                    key={template.slug}
                    className={cn(
                      "transition-colors",
                      enabled ? "border-primary/50" : "hover:border-border",
                    )}
                  >
                    <CardContent className="p-4 flex flex-col h-full">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-medium text-foreground">
                          {template.name}
                        </h3>
                        <span
                          className={cn(
                            "shrink-0 text-xs font-mono",
                            severityColor[template.severity] ??
                              "text-muted-foreground",
                          )}
                        >
                          [{template.severity}]
                        </span>
                      </div>

                      <p className="mt-1 text-xs text-muted-foreground leading-relaxed flex-1">
                        {template.description}
                      </p>

                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {categoryLabel[template.category] ??
                              template.category}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {template.ruleCount ?? 0} rule
                            {(template.ruleCount ?? 0) !== 1 ? "s" : ""}
                          </span>
                        </div>

                        {enabled ? (
                          <span className="text-xs text-primary">
                            [enabled]
                          </span>
                        ) : (
                          <button
                            onClick={() => setModalTemplate(template)}
                            className="text-xs text-muted-foreground hover:text-primary transition-colors"
                          >
                            [enable]
                          </button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Event types reference */}
            {eventTypes.length > 0 && (
              <div className="mt-8">
                <p className="mb-2 text-xs text-muted-foreground">
                  $ registry event-types ls
                </p>
                <div className="rounded border border-border overflow-hidden">
                  <div className="grid grid-cols-[200px_1fr] gap-x-3 border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <span>Type</span>
                    <span>Description</span>
                  </div>
                  {eventTypes.map((et) => (
                    <div
                      key={et.type}
                      className="grid grid-cols-[200px_1fr] gap-x-3 border-b border-border last:border-b-0 px-3 py-2 text-xs"
                    >
                      <span className="font-mono text-foreground truncate">
                        {et.type.replace("registry.", "")}
                      </span>
                      <span className="text-muted-foreground">
                        {et.description}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* -- built-in templates (fallback when API endpoint is not ready) ----- */

function getBuiltinTemplates(): DetectionTemplate[] {
  return [
    {
      slug: "registry-docker-monitor",
      name: "Docker Image Monitor",
      description:
        "Alert when a Docker image tag changes digest, a new tag appears, or a tag is removed. Baseline visibility into container image changes.",
      category: "container-security",
      severity: "medium",
      ruleCount: 1,
    },
    {
      slug: "registry-require-ci-attribution",
      name: "Require CI Attribution",
      description:
        "Alert when a release artifact changes without verified CI attribution. Detects manual pushes and untracked changes that bypass your CI/CD pipeline.",
      category: "supply-chain",
      severity: "high",
      ruleCount: 2,
    },
    {
      slug: "registry-enforce-signatures",
      name: "Enforce Signatures",
      description:
        "Alert when a Docker image lacks a cosign signature. Unsigned images may indicate a compromised build pipeline or a manual push that bypassed signing.",
      category: "supply-chain",
      severity: "critical",
      ruleCount: 1,
    },
    {
      slug: "registry-enforce-provenance",
      name: "Enforce Provenance",
      description:
        "Alert when a release artifact lacks a SLSA provenance attestation. Provenance cryptographically proves which source repository and build system produced the artifact.",
      category: "supply-chain",
      severity: "critical",
      ruleCount: 2,
    },
    {
      slug: "registry-npm-monitor",
      name: "npm Package Monitor",
      description:
        "Alert on npm version changes, install script additions, major version jumps, and maintainer changes. Comprehensive visibility into npm package mutations.",
      category: "package-security",
      severity: "high",
      ruleCount: 3,
    },
    {
      slug: "registry-full-security",
      name: "Full Release Chain Security",
      description:
        "Enable all release chain security monitors in one detection. Covers Docker digest/tag changes, npm version and maintainer changes, signature and provenance enforcement, CI attribution checks, and anomaly detection.",
      category: "comprehensive",
      severity: "critical",
      ruleCount: 8,
    },
  ];
}
