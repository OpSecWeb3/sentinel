"use client";

import { useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
} from "react-leaflet";
import { cn } from "@/lib/utils";

export interface MapEntry {
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

interface Cluster {
  lat: number;
  lon: number;
  points: MapEntry[];
}

interface WorldMapProps {
  points: MapEntry[];
  showLabels?: boolean;
  className?: string;
}

export default function WorldMap({
  points,
  showLabels = true,
  className,
}: WorldMapProps) {
  const clusters = useMemo<Cluster[]>(() => {
    const map = new Map<string, Cluster>();
    for (const p of points) {
      const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
      const existing = map.get(key);
      if (existing) {
        existing.points.push(p);
      } else {
        map.set(key, { lat: p.lat, lon: p.lon, points: [p] });
      }
    }
    return Array.from(map.values());
  }, [points]);

  return (
    <div className={cn("h-full w-full", className)}>
      <MapContainer
        center={[25, 0]}
        zoom={2}
        minZoom={2}
        maxZoom={12}
        style={{ height: "100%", width: "100%" }}
        zoomControl={true}
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={19}
        />
        {showLabels && (
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
            maxZoom={19}
          />
        )}
        {clusters.map((cluster) => {
          const count = cluster.points.length;
          const radius = Math.min(4 + Math.sqrt(count) * 3, 18);
          const hostnames = Array.from(
            new Set(cluster.points.map((p) => p.hostname)),
          );
          const providers = Array.from(
            new Set(
              cluster.points.map((p) => p.cloudProvider).filter(Boolean),
            ),
          );
          const location = cluster.points[0];

          return (
            <CircleMarker
              key={`${cluster.lat}-${cluster.lon}`}
              center={[cluster.lat, cluster.lon]}
              radius={radius}
              pathOptions={{
                color: "#22c55e",
                fillColor: "#22c55e",
                fillOpacity: count > 1 ? 0.5 : 0.7,
                weight: count > 1 ? 2 : 1,
              }}
            >
              <Popup>
                <div className="font-mono text-[11px] min-w-[180px] p-1">
                  <div className="text-muted-foreground mb-1.5 border-b border-border pb-1.5">
                    {location.city ? `${location.city}, ` : ""}
                    {location.country || "Unknown"}
                    {providers.length > 0 && (
                      <span className="text-primary ml-1.5">
                        [{providers.join(", ")}]
                      </span>
                    )}
                  </div>

                  {hostnames.slice(0, 5).map((hostname) => {
                    const hostnamePoints = cluster.points.filter(
                      (p) => p.hostname === hostname,
                    );
                    return (
                      <div key={hostname} className="mb-1">
                        <div className="text-foreground font-semibold">
                          {hostname}
                        </div>
                        {hostnamePoints.slice(0, 3).map((p) => (
                          <div key={p.ip} className="text-primary ml-2">
                            {p.ip}
                          </div>
                        ))}
                        {hostnamePoints.length > 3 && (
                          <div className="text-muted-foreground ml-2">
                            +{hostnamePoints.length - 3} more
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {hostnames.length > 5 && (
                    <div className="text-muted-foreground mt-0.5">
                      +{hostnames.length - 5} more hostnames
                    </div>
                  )}

                  <div className="text-muted-foreground mt-1.5 border-t border-border pt-1.5">
                    {count} total IP{count !== 1 ? "s" : ""}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}
