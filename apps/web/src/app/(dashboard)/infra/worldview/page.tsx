"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types --------------------------------------------------------- */

interface MapEntry {
  hostId: string;
  hostname: string;
  ip: string;
  lat: number;
  lon: number;
  country: string;
  city: string;
  cloudProvider: string;
  asn: string;
  asnOrg: string;
}

/* -- helpers -------------------------------------------------------- */

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

function makeBar(count: number, maxCount: number, maxWidth: number): string {
  const width = Math.max(1, Math.round((count / maxCount) * maxWidth));
  return "\u2588".repeat(width);
}

/* -- page ----------------------------------------------------------- */

export default function InfraWorldviewPage() {
  const [entries, setEntries] = useState<MapEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [expandedCountries, setExpandedCountries] = useState<Set<string>>(new Set());

  const fetchMap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ data: MapEntry[] }>(
        "/modules/infra/infrastructure/map",
        { credentials: "include" },
      );
      setEntries(res.data);
      // Auto-expand first 3 countries
      const countries = Object.keys(groupBy(res.data, (e) => e.country || "Unknown"));
      setExpandedCountries(new Set(countries.slice(0, 3)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load infrastructure map");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMap();
  }, [fetchMap]);

  function toggleCountry(country: string) {
    setExpandedCountries((prev) => {
      const next = new Set(prev);
      if (next.has(country)) next.delete(country);
      else next.add(country);
      return next;
    });
  }

  /* -- derived data ------------------------------------------------- */

  const byCountry = groupBy(entries, (e) => e.country || "Unknown");
  const countriesSorted = Object.entries(byCountry).sort(
    (a, b) => b[1].length - a[1].length,
  );

  const byProvider = groupBy(entries, (e) => e.cloudProvider || "unknown");
  const providersSorted = Object.entries(byProvider).sort(
    (a, b) => b[1].length - a[1].length,
  );
  const maxProviderCount = providersSorted.length > 0 ? providersSorted[0][1].length : 1;

  const uniqueCountries = Object.keys(byCountry).length;

  /* -- render ------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ infra worldview
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} geographic distribution of monitored infrastructure
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/infra">{"<"} overview</Link>
        </Button>
      </div>

      {/* Content */}
      {showLoading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i}>
                <CardContent className="p-4 space-y-3 animate-pulse">
                  <div className="h-3 bg-muted-foreground/20 rounded w-1/3" />
                  <div className="h-8 bg-muted-foreground/20 rounded w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardContent className="p-4 space-y-3 animate-pulse">
              <div className="h-3 bg-muted-foreground/20 rounded w-1/4" />
              <div className="h-3 bg-muted-foreground/20 rounded w-full" />
              <div className="h-3 bg-muted-foreground/20 rounded w-3/4" />
            </CardContent>
          </Card>
        </div>
      ) : error ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={fetchMap}>
              $ retry
            </Button>
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{">"} no infrastructure data available</p>
            <p className="mt-1 text-xs text-muted-foreground">
              add hosts and run scans to populate the worldview
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6 animate-content-ready">
          {/* Summary stats */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">TOTAL_HOSTS</p>
                <p className="mt-1 text-2xl font-bold text-primary text-glow">
                  {entries.length}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">[OK]</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">COUNTRIES</p>
                <p className="mt-1 text-2xl font-bold text-primary text-glow">
                  {uniqueCountries}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  unique locations
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">PROVIDERS</p>
                <p className="mt-1 text-2xl font-bold text-primary text-glow">
                  {providersSorted.length}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  cloud providers detected
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Cloud provider breakdown */}
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-3">
                $ infra providers --breakdown
              </p>
              <div className="space-y-1">
                {providersSorted.map(([provider, hosts]) => (
                  <div key={provider} className="flex items-center gap-3 text-xs font-mono">
                    <span className="w-20 text-right text-foreground shrink-0">
                      {provider}:
                    </span>
                    <span className="text-primary">
                      {makeBar(hosts.length, maxProviderCount, 24)}
                    </span>
                    <span className="text-muted-foreground">
                      {hosts.length}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Grouped by country */}
          <div>
            <p className="text-xs text-muted-foreground mb-3 px-2">
              $ infra hosts --group-by country
            </p>
            <div className="space-y-2">
              {countriesSorted.map(([country, hosts]) => {
                const expanded = expandedCountries.has(country);
                return (
                  <Card key={country}>
                    <CardContent className="p-0">
                      <button
                        onClick={() => toggleCountry(country)}
                        className="w-full flex items-center justify-between px-4 py-3 text-left group"
                      >
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">{">"}</span>
                          <span className="text-foreground font-medium group-hover:text-primary transition-colors">
                            {country}
                          </span>
                          <span className="text-muted-foreground">
                            ({hosts.length} host{hosts.length !== 1 ? "s" : ""})
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {expanded ? "[-]" : "[+]"}
                        </span>
                      </button>

                      {expanded && (
                        <div className="border-t border-border">
                          <div className="grid grid-cols-[minmax(150px,2fr)_120px_100px_150px] gap-x-3 border-b border-border px-4 py-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                            <span>Hostname</span>
                            <span>IP</span>
                            <span>Provider</span>
                            <span>ASN</span>
                          </div>
                          {hosts.map((host) => (
                            <div
                              key={host.hostId}
                              className="grid grid-cols-[minmax(150px,2fr)_120px_100px_150px] gap-x-3 px-4 py-1.5 text-xs border border-transparent hover:border-border hover:bg-muted/30 transition-colors"
                            >
                              <Link
                                href={`/infra/hosts/${host.hostId}`}
                                className="text-foreground hover:text-primary transition-colors font-mono truncate"
                              >
                                {host.hostname}
                              </Link>
                              <span className="text-foreground font-mono">
                                {host.ip}
                              </span>
                              <span className="text-muted-foreground">
                                {host.cloudProvider || "--"}
                              </span>
                              <span className="text-muted-foreground font-mono truncate">
                                {host.asn || "--"}
                                {host.asnOrg ? ` (${host.asnOrg})` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
