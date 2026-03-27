"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { cn } from "@/lib/utils";
import { apiGet, apiPost } from "@/lib/api";

/* -- types --------------------------------------------------------- */

interface Template {
  slug: string;
  name: string;
  description: string;
  category: string;
  severity: string;
  ruleCount: number;
  rules?: unknown[];
}

/* -- helpers ------------------------------------------------------- */

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
  info: "text-muted-foreground",
};

const severityBadgeVariant: Record<string, "destructive" | "warning" | "default" | "secondary"> = {
  critical: "destructive",
  high: "warning",
  medium: "default",
  low: "secondary",
  info: "secondary",
};

const CATEGORIES = [
  "all",
  "access-control",
  "code-protection",
  "secrets",
  "organization",
  "comprehensive",
];

/* -- page ---------------------------------------------------------- */

export default function GitHubTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [enableLoading, setEnableLoading] = useState<Record<string, boolean>>({});
  const [enabledTemplates, setEnabledTemplates] = useState<Set<string>>(new Set());
  const { toasts, toast, dismiss } = useToast();

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ data: Template[] }>("/modules/github/templates");
      setTemplates(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const filteredTemplates = templates.filter((t) => {
    if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
    return true;
  });

  async function handleEnable(template: Template) {
    setEnableLoading((prev) => ({ ...prev, [template.slug]: true }));
    try {
      await apiPost("/api/detections/from-template", {
        templateSlug: template.slug,
        moduleId: "github",
      });
      setEnabledTemplates((prev) => new Set(prev).add(template.slug));
      toast(`Detection created from "${template.name}"`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to enable template");
    } finally {
      setEnableLoading((prev) => ({ ...prev, [template.slug]: false }));
    }
  }

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ github templates ls
            {categoryFilter !== "all" && (
              <span className="text-muted-foreground"> --category {categoryFilter}</span>
            )}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} detection template gallery for github module
          </p>
        </div>
        <Link
          href="/github"
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          [back]
        </Link>
      </div>

      {/* Category Filter */}
      <div className="space-y-1.5 text-xs">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-muted-foreground w-20">--category</span>
          {CATEGORIES.map((cat) => (
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
      </div>

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" : "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 invisible"}>
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded border border-border bg-muted/20" />
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchTemplates}>
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : filteredTemplates.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no templates found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {categoryFilter !== "all"
                  ? "try selecting a different category"
                  : "no detection templates available"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="animate-content-ready">
            <p className="mb-4 text-xs text-muted-foreground">
              {filteredTemplates.length} template{filteredTemplates.length !== 1 ? "s" : ""}
              {filteredTemplates.length !== templates.length && ` of ${templates.length} total`}
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTemplates.map((template) => {
                const busy = enableLoading[template.slug] ?? false;
                const isEnabled = enabledTemplates.has(template.slug);

                return (
                  <Card key={template.slug} className="flex flex-col">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-foreground">
                          {template.name}
                        </CardTitle>
                        <Badge variant={severityBadgeVariant[template.severity] ?? "secondary"}>
                          [{template.severity}]
                        </Badge>
                      </div>
                      <CardDescription>{template.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 flex flex-col justify-end">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-muted-foreground font-mono">
                            cat:{template.category}
                          </span>
                          <span className="text-muted-foreground font-mono">
                            rules:{template.ruleCount ?? (template.rules ? template.rules.length : 0)}
                          </span>
                        </div>
                        <button
                          disabled={busy || isEnabled}
                          onClick={() => handleEnable(template)}
                          className={cn(
                            "text-xs font-mono transition-colors disabled:opacity-50",
                            isEnabled
                              ? "text-primary"
                              : "text-muted-foreground hover:text-primary",
                          )}
                        >
                          {busy ? "..." : isEnabled ? "[enabled]" : "[enable]"}
                        </button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
