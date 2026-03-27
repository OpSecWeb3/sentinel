"use client";

import "leaflet/dist/leaflet.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import type { MapEntry } from "@/components/world-map";

const WorldMap = dynamic(() => import("@/components/world-map"), { ssr: false });

/* -- page ----------------------------------------------------------- */

export default function InfraWorldviewPage() {
  const [entries, setEntries] = useState<MapEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(false);

  const fetchMap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ data: MapEntry[] }>(
        "/modules/infra/infrastructure/map",
        { credentials: "include" },
      );
      setEntries(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load infrastructure map");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMap();
  }, [fetchMap]);

  const hostCount = useMemo(
    () => new Set(entries.map((e) => e.hostId)).size,
    [entries],
  );

  const locationCount = useMemo(() => {
    const keys = new Set(
      entries.map((e) => `${e.lat.toFixed(2)},${e.lon.toFixed(2)}`),
    );
    return keys.size;
  }, [entries]);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-lg text-primary text-glow font-mono">
            $ infra worldview
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} geographic distribution of monitored infrastructure
          </p>
        </div>
        <div className="flex items-center gap-3">
          {entries.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground font-mono">
                {entries.length} IPs · {hostCount} hosts · {locationCount} locations
              </span>
              <button
                onClick={() => setShowLabels(!showLabels)}
                className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
              >
                {showLabels ? "[hide countries]" : "[show countries]"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Map area — fills remaining height */}
      <div className="flex-1 min-h-0 border border-border overflow-hidden">
        {(showLoading || loading) && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-primary font-mono">
              {">"} loading infrastructure map...
              <span className="ml-1 animate-pulse">_</span>
            </p>
          </div>
        )}

        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-sm text-destructive font-mono">[ERR] {error}</p>
            <Button variant="outline" size="sm" onClick={fetchMap}>
              $ retry
            </Button>
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-sm text-muted-foreground font-mono">
              {">"} no geolocated infrastructure data
            </p>
            <p className="text-xs text-muted-foreground">
              add hosts and run scans to populate the worldview
            </p>
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <WorldMap
            points={entries}
            showLabels={showLabels}
            className="h-full w-full"
          />
        )}
      </div>
    </div>
  );
}
