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

interface Host {
  id: string;
  hostname: string;
  status: string;
}

/* -- helpers -------------------------------------------------------- */

const severityBadgeVariant: Record<string, "destructive" | "warning" | "default" | "secondary"> = {
  critical: "destructive",
  high: "warning",
  medium: "default",
  low: "secondary",
};

/* -- host picker modal --------------------------------------------- */

function HostPickerModal({
  template,
  hosts,
  hostsLoading,
  onConfirm,
  onCancel,
}: {
  template: Template;
  hosts: Host[];
  hostsLoading: boolean;
  onConfirm: (hostIds: string[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl space-y-4">
        <div>
          <h2 className="text-sm font-mono text-primary">$ enable detection template</h2>
          <p className="mt-1 text-xs text-muted-foreground">{template.name}</p>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground mb-2">
            {">"} select hosts to scope this detection to (leave all unchecked = org-wide):
          </p>
          {hostsLoading ? (
            <p className="text-xs text-muted-foreground animate-pulse">loading hosts...</p>
          ) : hosts.length === 0 ? (
            <p className="text-xs text-muted-foreground">[no hosts found — detection will be org-wide]</p>
          ) : (
            <div className="max-h-52 overflow-y-auto space-y-1 rounded border border-border p-2">
              {hosts.map((h) => (
                <button
                  key={h.id}
                  onClick={() => toggle(h.id)}
                  className={cn(
                    "w-full flex items-center justify-between px-2 py-1.5 rounded text-xs font-mono transition-colors text-left",
                    selected.has(h.id)
                      ? "bg-primary/10 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/30",
                  )}
                >
                  <span>{h.hostname}</span>
                  <span className={cn("text-[10px]", h.status === "active" ? "text-primary" : "text-muted-foreground")}>
                    [{h.status}]
                  </span>
                </button>
              ))}
            </div>
          )}
          {selected.size > 0 && (
            <p className="text-[10px] text-muted-foreground pt-1">
              {selected.size} host{selected.size !== 1 ? "s" : ""} selected
            </p>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => onConfirm([...selected])}>
            $ create detection
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            [cancel]
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -- page ----------------------------------------------------------- */

export default function InfraTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enableLoading, setEnableLoading] = useState<Record<string, boolean>>({});
  const [enabledTemplates, setEnabledTemplates] = useState<Set<string>>(new Set());
  const { toasts, toast, dismiss } = useToast();

  // Host picker state
  const [pickerTemplate, setPickerTemplate] = useState<Template | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);

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

  async function openPicker(template: Template) {
    setPickerTemplate(template);
    if (hosts.length === 0) {
      setHostsLoading(true);
      try {
        const res = await apiGet<{ data: Host[] }>("/modules/infra/hosts?limit=100");
        setHosts(res.data ?? []);
      } catch {
        // non-fatal; picker will show empty state
      } finally {
        setHostsLoading(false);
      }
    }
  }

  async function confirmEnable(template: Template, hostIds: string[]) {
    setPickerTemplate(null);
    setEnableLoading((prev) => ({ ...prev, [template.slug]: true }));
    try {
      await apiPost("/api/detections/from-template", {
        templateSlug: template.slug,
        moduleId: "infra",
        // Pass selected host IDs in overrides so evaluators can filter by host
        overrides: hostIds.length > 0 ? { hostIds } : {},
      });
      setEnabledTemplates((prev) => new Set(prev).add(template.slug));
      const scope = hostIds.length > 0 ? ` → ${hostIds.length} host${hostIds.length !== 1 ? "s" : ""}` : " → org-wide";
      toast(`Detection created from "${template.name}"${scope}`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to enable template");
    } finally {
      setEnableLoading((prev) => ({ ...prev, [template.slug]: false }));
    }
  }

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {pickerTemplate && (
        <HostPickerModal
          template={pickerTemplate}
          hosts={hosts}
          hostsLoading={hostsLoading}
          onConfirm={(ids) => confirmEnable(pickerTemplate, ids)}
          onCancel={() => setPickerTemplate(null)}
        />
      )}

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
                      onClick={() => openPicker(template)}
                      className={cn(
                        "text-xs font-mono transition-colors disabled:opacity-50 text-left",
                        enabled ? "text-primary" : "text-muted-foreground hover:text-primary",
                      )}
                    >
                      {busy ? "..." : enabled ? "[enabled]" : "[enable →]"}
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
