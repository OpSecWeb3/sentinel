"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { PayloadTree } from "@/components/event-payload-tree";

/* ── types ───────────────────────────────────────────────────── */

interface EventDetail {
  id: string;
  orgId: string;
  moduleId: string;
  eventType: string;
  externalId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
}

interface LinkedAlert {
  id: string | number;
  severity: string;
  title: string;
  triggerType: string;
  notificationStatus: string;
  createdAt: string;
  detectionId: string | null;
}

interface EventResponse {
  data: EventDetail;
  alerts: LinkedAlert[];
}

/* ── constants ───────────────────────────────────────────────── */

const MODULE_COLORS: Record<string, string> = {
  chain: "text-yellow-500",
  github: "text-purple-400",
  infra: "text-blue-400",
  registry: "text-teal-400",
  aws: "text-orange-400",
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

/* ── helpers ─────────────────────────────────────────────────── */

function TreeLine({ last = false }: { last?: boolean }) {
  return (
    <span className="text-muted-foreground/50 select-none">
      {last ? "└── " : "├── "}
    </span>
  );
}

function TreeValue({
  label,
  value,
  last = false,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  last?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="flex">
      <TreeLine last={last} />
      <span className="text-muted-foreground">{label}:</span>
      <span
        className={cn("ml-1 break-all", valueClassName ?? "text-foreground")}
      >
        {value}
      </span>
    </div>
  );
}

/* ── page ────────────────────────────────────────────────────── */

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [alerts, setAlerts] = useState<LinkedAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<EventResponse>(`/api/events/${params.id}`, {
          credentials: "include",
        });
        setEvent(res.data);
        setAlerts(res.alerts ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [params.id]);

  if (showLoading) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-primary">
          {">"} loading event {params.id.slice(0, 8)}...
          <span className="ml-1 animate-pulse">_</span>
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-destructive">
          [ERR] failed to load event: {error}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4 text-xs"
          onClick={() => router.refresh()}
        >
          $ retry
        </Button>
      </div>
    );
  }

  if (!event) return null;

  const moduleColor = MODULE_COLORS[event.moduleId] ?? "text-primary";
  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(event.payload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4 animate-content-ready">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link
              href="/events"
              className="hover:text-primary transition-colors"
            >
              events
            </Link>
            {" / "}
            <span className="text-foreground">{event.id.slice(0, 8)}</span>
          </p>
          <h1 className="text-lg text-primary text-glow">
            $ event inspect
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} {event.eventType}
          </p>
        </div>
        <span className={cn("text-xs font-mono uppercase font-bold", moduleColor)}>
          [{event.moduleId}]
        </span>
      </div>

      {/* Metadata tree */}
      <div className="border border-border rounded-md p-4 font-mono text-sm leading-relaxed bg-card">
        <div className="text-primary font-bold mb-2 text-xs uppercase tracking-wider">
          Event Metadata
        </div>
        <div className="text-foreground font-bold mb-1">event/</div>
        <TreeValue label="id" value={event.id} />
        <TreeValue
          label="module"
          value={event.moduleId}
          valueClassName={moduleColor}
        />
        <TreeValue label="type" value={event.eventType} />
        <TreeValue
          label="external_id"
          value={event.externalId ?? "--"}
          valueClassName={
            event.externalId ? "text-foreground" : "text-muted-foreground/60"
          }
        />
        <TreeValue label="occurred_at" value={event.occurredAt} />
        <TreeValue label="received_at" value={event.receivedAt} last />
      </div>

      {/* Payload tree */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-muted-foreground font-mono">
            $ cat event/{event.id.slice(0, 8)}/payload.json
          </p>
          <button
            type="button"
            onClick={handleCopy}
            className="text-xs text-muted-foreground hover:text-primary transition-colors font-mono"
          >
            {copied ? "[copied]" : "[copy]"}
          </button>
        </div>
        <PayloadTree
          payload={event.payload}
          rootLabel={`event/${event.id.slice(0, 8)}/`}
        />
      </div>

      {/* Linked alerts */}
      {alerts.length > 0 && (
        <div className="border border-border rounded-md p-4 font-mono text-sm leading-relaxed bg-card">
          <div className="text-primary font-bold mb-2 text-xs uppercase tracking-wider">
            Linked Alerts ({alerts.length})
          </div>
          <div className="text-foreground font-bold mb-1">alerts/</div>
          {alerts.map((a, i) => {
            const last = i === alerts.length - 1;
            const sev = a.severity.toLowerCase();
            return (
              <div key={String(a.id)} className="flex items-baseline">
                <TreeLine last={last} />
                <Link
                  href={`/alerts/${a.id}`}
                  className="text-primary hover:underline"
                >
                  #{String(a.id)}
                </Link>
                <span
                  className={cn(
                    "ml-2 font-bold uppercase text-xs",
                    SEVERITY_COLOR[sev] ?? "text-muted-foreground",
                  )}
                >
                  {a.severity}
                </span>
                <span className="ml-2 text-foreground truncate" title={a.title}>
                  {a.title}
                </span>
                <span className="ml-2 text-muted-foreground text-xs whitespace-nowrap">
                  {new Date(a.createdAt).toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
