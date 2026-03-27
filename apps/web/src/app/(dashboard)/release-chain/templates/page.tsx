"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

/* -- page ------------------------------------------------------------ */

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<DetectionTemplate[]>([]);
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [enablingSlug, setEnablingSlug] = useState<string | null>(null);
  const [enabledSlugs, setEnabledSlugs] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventTypesRes, templatesRes] = await Promise.allSettled([
        apiFetch<{ data: EventType[] }>(
          "/modules/release-chain/event-types",
          { credentials: "include" },
        ),
        apiFetch<{ data: DetectionTemplate[] }>(
          "/modules/release-chain/templates",
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

  /* -- enable template ----------------------------------------------- */

  async function enableTemplate(template: DetectionTemplate) {
    setEnablingSlug(template.slug);
    try {
      await apiFetch("/api/detections/from-template", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleId: "release-chain",
          templateSlug: template.slug,
        }),
      });
      setEnabledSlugs((prev) => new Set([...prev, template.slug]));
      toast(`Detection "${template.name}" enabled.`);
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to enable template",
      );
    } finally {
      setEnablingSlug(null);
    }
  }

  /* -- filter -------------------------------------------------------- */

  const categories = Array.from(new Set(templates.map((t) => t.category)));
  const filteredTemplates =
    categoryFilter === "all"
      ? templates
      : templates.filter((t) => t.category === categoryFilter);

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ release-chain templates ls
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} pre-built detection templates for supply chain security
        </p>
      </div>

      {/* Category filter */}
      {templates.length > 0 && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">--category</span>
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
              {filteredTemplates.length} template{filteredTemplates.length !== 1 ? "s" : ""}
              {categoryFilter !== "all" ? ` in ${categoryFilter}` : ""}
            </p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTemplates.map((template) => {
                const enabled = enabledSlugs.has(template.slug);
                const busy = enablingSlug === template.slug;

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
                            severityColor[template.severity] ?? "text-muted-foreground",
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
                            {categoryLabel[template.category] ?? template.category}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {template.ruleCount ?? 0} rule{(template.ruleCount ?? 0) !== 1 ? "s" : ""}
                          </span>
                        </div>

                        {enabled ? (
                          <span className="text-xs text-primary">[enabled]</span>
                        ) : (
                          <button
                            disabled={busy}
                            onClick={() => enableTemplate(template)}
                            className="text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                          >
                            {busy ? "> enabling..." : "[enable]"}
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
                  $ release-chain event-types ls
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
                        {et.type.replace("release-chain.", "")}
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
      slug: "release-chain-docker-monitor",
      name: "Docker Image Monitor",
      description:
        "Alert when a Docker image tag changes digest, a new tag appears, or a tag is removed. Baseline visibility into container image changes.",
      category: "container-security",
      severity: "medium",
      rules: [{ ruleType: "release-chain.digest_change", action: "alert" }],
    },
    {
      slug: "release-chain-require-ci-attribution",
      name: "Require CI Attribution",
      description:
        "Alert when a release artifact changes without verified CI attribution. Detects manual pushes and untracked changes that bypass your CI/CD pipeline.",
      category: "supply-chain",
      severity: "high",
      rules: [
        { ruleType: "release-chain.attribution", action: "alert" },
        { ruleType: "release-chain.attribution", action: "alert" },
      ],
    },
    {
      slug: "release-chain-enforce-signatures",
      name: "Enforce Signatures",
      description:
        "Alert when a Docker image lacks a cosign signature. Unsigned images may indicate a compromised build pipeline or a manual push that bypassed signing.",
      category: "supply-chain",
      severity: "critical",
      rules: [{ ruleType: "release-chain.security_policy", action: "alert" }],
    },
    {
      slug: "release-chain-enforce-provenance",
      name: "Enforce Provenance",
      description:
        "Alert when a release artifact lacks a SLSA provenance attestation. Provenance cryptographically proves which source repository and build system produced the artifact.",
      category: "supply-chain",
      severity: "critical",
      rules: [
        { ruleType: "release-chain.security_policy", action: "alert" },
        { ruleType: "release-chain.security_policy", action: "alert" },
      ],
    },
    {
      slug: "release-chain-npm-monitor",
      name: "npm Package Monitor",
      description:
        "Alert on npm version changes, install script additions, major version jumps, and maintainer changes. Comprehensive visibility into npm package mutations.",
      category: "package-security",
      severity: "high",
      rules: [
        { ruleType: "release-chain.npm_checks", action: "alert" },
        { ruleType: "release-chain.npm_checks", action: "alert" },
        { ruleType: "release-chain.npm_checks", action: "alert" },
      ],
    },
    {
      slug: "release-chain-full-security",
      name: "Full Release Chain Security",
      description:
        "Enable all release chain security monitors in one detection. Covers Docker digest/tag changes, npm version and maintainer changes, signature and provenance enforcement, CI attribution checks, and anomaly detection.",
      category: "comprehensive",
      severity: "critical",
      rules: [
        { ruleType: "release-chain.digest_change", action: "alert" },
        { ruleType: "release-chain.security_policy", action: "alert" },
        { ruleType: "release-chain.attribution", action: "alert" },
        { ruleType: "release-chain.npm_checks", action: "alert" },
        { ruleType: "release-chain.npm_checks", action: "alert" },
        { ruleType: "release-chain.security_policy", action: "alert" },
        { ruleType: "release-chain.attribution", action: "alert" },
        { ruleType: "release-chain.anomaly_detection", action: "alert" },
      ],
    },
  ];
}
