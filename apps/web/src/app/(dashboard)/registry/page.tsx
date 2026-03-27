"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types ----------------------------------------------------------- */

interface ModuleStats {
  monitoredImages: number;
  monitoredPackages: number;
  recentEvents: number;
  verifications: number;
}

/* -- page ------------------------------------------------------------ */

export default function RegistryOverviewPage() {
  const [stats, setStats] = useState<ModuleStats>({
    monitoredImages: 0,
    monitoredPackages: 0,
    recentEvents: 0,
    verifications: 0,
  });
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch images, packages, and recent events in parallel
      const [imagesRes, packagesRes, eventsRes] = await Promise.allSettled([
        apiFetch<{ data: unknown[] }>("/modules/registry/images", {
          credentials: "include",
        }),
        apiFetch<{ data: unknown[] }>("/modules/registry/packages", {
          credentials: "include",
        }),
        apiFetch<{ data: unknown[]; meta?: { total?: number } }>(
          "/api/events?moduleId=registry&limit=50",
          { credentials: "include" },
        ),
      ]);

      const images =
        imagesRes.status === "fulfilled" ? imagesRes.value.data.length : 0;
      const packages =
        packagesRes.status === "fulfilled" ? packagesRes.value.data.length : 0;
      const events =
        eventsRes.status === "fulfilled"
          ? eventsRes.value.meta?.total ?? eventsRes.value.data.length
          : 0;

      // Count verification-related events
      const verifications =
        eventsRes.status === "fulfilled"
          ? eventsRes.value.data.filter((e: unknown) => {
              const evt = e as { type?: string };
              return evt.type?.includes("verification") || evt.type?.includes("signature") || evt.type?.includes("provenance");
            }).length
          : 0;

      setStats({
        monitoredImages: images,
        monitoredPackages: packages,
        recentEvents: events,
        verifications,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  /* -- stat cards ---------------------------------------------------- */

  const statCards = [
    {
      label: "monitored images",
      value: stats.monitoredImages,
      icon: "[img]",
      href: "/registry/images",
      color: "text-primary",
    },
    {
      label: "monitored packages",
      value: stats.monitoredPackages,
      icon: "[pkg]",
      href: "/registry/packages",
      color: "text-primary",
    },
    {
      label: "recent events",
      value: stats.recentEvents,
      icon: "[evt]",
      href: "/registry/events",
      color: "text-warning",
    },
    {
      label: "verifications",
      value: stats.verifications,
      icon: "[sig]",
      href: "/registry/events",
      color: "text-primary",
    },
  ];

  const quickLinks = [
    { title: "images/", desc: "manage monitored Docker images", href: "/registry/images" },
    { title: "packages/", desc: "manage monitored npm packages", href: "/registry/packages" },
    { title: "templates/", desc: "detection template gallery", href: "/registry/templates" },
    { title: "events/", desc: "release chain event log", href: "/registry/events" },
  ];

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6 font-mono">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ registry status
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} supply chain security monitoring for Docker images and npm packages
        </p>
      </div>

      {/* Stats */}
      {showLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-6 w-10 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={fetchStats}>
              $ retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 animate-stagger">
          {statCards.map((card) => (
            <Link key={card.label} href={card.href}>
              <Card className="transition-colors hover:border-primary/50">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{card.label}</span>
                    <span className="text-xs text-muted-foreground">{card.icon}</span>
                  </div>
                  <p className={`mt-1 text-2xl font-mono font-bold ${card.color}`}>
                    {card.value}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* Quick navigation */}
      <div>
        <p className="mb-2 text-xs text-muted-foreground">~/registry/</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {quickLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card className="transition-colors hover:border-primary/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{"\u251C\u2500\u2500"}</span>
                    <span className="text-sm text-foreground font-medium">{link.title}</span>
                  </div>
                  <p className="ml-6 mt-1 text-xs text-muted-foreground">
                    {">"} {link.desc}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* CI Notification Setup */}
      <Card>
        <CardContent className="p-4">
          <p className="text-sm font-medium text-foreground">
            $ registry ci --setup
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} configure CI notifications to attribute Docker pushes to your pipeline
          </p>

          <div className="mt-4 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">1. Generate a notify key in Settings {">"} API Keys</p>
              <div className="rounded border border-border bg-muted/30 p-3 font-mono text-xs text-foreground">
                <span className="text-muted-foreground"># settings page will provide your key</span>
                <br />
                SENTINEL_NOTIFY_KEY=snk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">2. Add to your GitHub Actions workflow after docker push:</p>
              <div className="rounded border border-border bg-muted/30 p-3 font-mono text-xs text-foreground overflow-x-auto">
                <pre className="whitespace-pre">{`- name: Notify Sentinel
  run: |
    curl -X POST \\
      \${{ secrets.SENTINEL_URL }}/modules/registry/ci/notify \\
      -H "Authorization: Bearer \${{ secrets.SENTINEL_NOTIFY_KEY }}" \\
      -H "Content-Type: application/json" \\
      -d '{
        "image": "your-org/your-image",
        "tag": "\${{ github.sha }}",
        "digest": "\${{ steps.push.outputs.digest }}",
        "runId": \${{ github.run_id }},
        "commit": "\${{ github.sha }}",
        "actor": "\${{ github.actor }}",
        "workflow": "\${{ github.workflow }}",
        "repo": "\${{ github.repository }}"
      }'`}</pre>
              </div>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">3. Enable the "Require CI Attribution" detection template:</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/registry/templates">$ browse templates</Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
