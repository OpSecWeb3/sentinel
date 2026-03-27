"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

import { apiGet, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";

/* -- types --------------------------------------------------------- */

interface Template {
  slug: string;
  name: string;
  description: string;
  category: string;
  severity: string;
  rules?: unknown[];
}

/* -- helpers -------------------------------------------------------- */

const severityBadgeVariant: Record<string, "destructive" | "warning" | "default" | "secondary"> = {
  critical: "destructive",
  high: "warning",
  medium: "default",
  low: "secondary",
};

/* -- page ----------------------------------------------------------- */

export default function InfraTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enableLoading, setEnableLoading] = useState<Record<string, boolean>>({});
  const [enabledTemplates, setEnabledTemplates] = useState<Set<string>>(new Set());
  const { toasts, toast, dismiss } = useToast();

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ data: Template[] }>("/modules/infra/templates");
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

  async function enableTemplate(template: Template) {
    setEnableLoading((prev) => ({ ...prev, [template.slug]: true }));
    try {
      await apiPost("/api/detections/from-template", {
        templateSlug: template.slug,
        moduleId: "infra",
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
            $ infra templates ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} pre-built detection templates for infrastructure monitoring
          </p>
        </div>
        <Link
          href="/infra"
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          [back]
        </Link>
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded border border-border bg-muted/20" />
          ))}
        </div>
      ) : error ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive">[ERR] {error}</p>
          <Button variant="outline" size="sm" onClick={fetchTemplates}>$ retry</Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {templates.length} template{templates.length !== 1 ? "s" : ""}
          </p>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => {
              const busy = enableLoading[template.slug] ?? false;
              const enabled = enabledTemplates.has(template.slug);

              return (
                <Card key={template.slug} className="flex flex-col">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm text-foreground">
                        {template.name}
                      </CardTitle>
                      <Badge variant={severityBadgeVariant[template.severity] ?? "secondary"}>
                        [{template.severity}]
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {template.description}
                    </p>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col justify-end gap-3">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono">
                      <span>cat:{template.category}</span>
                      <span>
                        rules:{Array.isArray(template.rules) ? template.rules.length : 0}
                      </span>
                    </div>
                    <button
                      disabled={busy || enabled}
                      onClick={() => enableTemplate(template)}
                      className={cn(
                        "text-xs font-mono transition-colors disabled:opacity-50 text-left",
                        enabled ? "text-primary" : "text-muted-foreground hover:text-primary",
                      )}
                    >
                      {busy ? "..." : enabled ? "[enabled]" : "[enable]"}
                    </button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
