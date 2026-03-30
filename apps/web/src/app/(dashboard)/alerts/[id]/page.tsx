"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

interface AlertDetail {
  id: number;
  orgId: string;
  detectionId: string | null;
  ruleId: string | null;
  eventId: string | null;
  severity: string;
  title: string;
  description: string | null;
  triggerType: string;
  triggerData: Record<string, unknown>;
  notificationStatus: string;
  notifications: NotificationEntry[];
  createdAt: string;
  detectionName: string | null;
  event: Record<string, unknown> | null;
}

interface NotificationEntry {
  status: string;
  channelType: string;
  channelId: string;
  error?: string;
}

interface NotificationDelivery {
  id: number;
  alertId: number;
  channelId: string;
  channelType: string;
  status: string;
  statusCode: number | null;
  responseTimeMs: number | null;
  error: string | null;
  attemptCount: number;
  sentAt: string | null;
  createdAt: string;
}

/* ── constants ──────────────────────────────────────────────── */

const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const SEVERITY_BADGE_COLOR: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const NOTIF_STATUS_COLOR: Record<string, string> = {
  sent: "text-primary",
  pending: "text-warning",
  failed: "text-destructive",
};

/* ── helpers ─────────────────────────────────────────────────── */

function TreeLine({ last = false }: { last?: boolean }) {
  return (
    <span className="text-muted-foreground/50 select-none">
      {last ? "└── " : "├── "}
    </span>
  );
}

function TreeBranch({ last = false }: { last?: boolean }) {
  return (
    <span className="text-muted-foreground/50 select-none">
      {last ? "    " : "│   "}
    </span>
  );
}

function TreeValue({
  label,
  value,
  last = false,
  valueClassName,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  last?: boolean;
  valueClassName?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex">
      <TreeLine last={last} />
      <span className="text-muted-foreground">{label}:</span>
      <span
        className={cn(
          "ml-1",
          mono && "font-mono",
          valueClassName ?? "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function TreeSection({
  label,
  last = false,
  labelClassName,
  children,
}: {
  label: string;
  last?: boolean;
  labelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex">
        <TreeLine last={last} />
        <span className={labelClassName ?? "text-muted-foreground"}>{label}/</span>
      </div>
      <div className="ml-0">
        {/* indent children under the branch line */}
        <div className="pl-0">
          {/* Use branch continuations */}
          <div className="flex flex-col">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderJsonTree(
  obj: Record<string, unknown>,
  parentLast: boolean,
  depth = 0,
): React.ReactNode[] {
  const entries = Object.entries(obj);
  return entries.map(([key, val], idx) => {
    const isLast = idx === entries.length - 1;
    const prefix = parentLast ? "    " : "│   ";
    const connector = isLast ? "└── " : "├── ";

    if (val && typeof val === "object" && !Array.isArray(val)) {
      return (
        <div key={key}>
          <div className="flex">
            <span className="text-muted-foreground/50 select-none whitespace-pre">
              {prefix.repeat(depth + 1)}{connector}
            </span>
            <span className="text-muted-foreground">{key}/</span>
          </div>
          {renderJsonTree(val as Record<string, unknown>, isLast, depth + 1)}
        </div>
      );
    }

    const display =
      Array.isArray(val)
        ? val.length === 0
          ? "[]"
          : JSON.stringify(val)
        : String(val ?? "null");

    return (
      <div key={key} className="flex">
        <span className="text-muted-foreground/50 select-none whitespace-pre">
          {prefix.repeat(depth + 1)}{connector}
        </span>
        <span className="text-muted-foreground">{key}:</span>
        <span className="ml-1 break-all text-muted-foreground">
          {display}
        </span>
      </div>
    );
  });
}

/* ── page ────────────────────────────────────────────────────── */

export default function AlertDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [alert, setAlert] = useState<AlertDetail | null>(null);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [alertRes, deliveriesRes] = await Promise.all([
          apiFetch<{ data: AlertDetail }>(`/api/alerts/${params.id}`, {
            credentials: "include",
          }),
          apiFetch<{ data: NotificationDelivery[] }>(
            `/api/notification-deliveries?alertId=${params.id}&limit=50`,
            { credentials: "include" },
          ),
        ]);
        setAlert(alertRes.data);
        setDeliveries(deliveriesRes.data);
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
          {">"} loading alert #{params.id}...
          <span className="ml-1 animate-pulse">_</span>
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-destructive">
          [ERR] failed to load alert: {error}
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

  if (!alert) return null;

  const sev = alert.severity.toLowerCase();
  const triggerEntries = alert.triggerData
    ? Object.entries(alert.triggerData)
    : [];
  const hasNotifications =
    (alert.notifications && alert.notifications.length > 0) ||
    deliveries.length > 0;

  return (
    <div className="space-y-4 animate-content-ready">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link
              href="/alerts"
              className="hover:text-primary transition-colors"
            >
              alerts
            </Link>
            {" / "}
            <span className="text-foreground">#{String(alert.id)}</span>
          </p>
          <h1 className="text-lg text-primary text-glow">
            $ alert inspect
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} {alert.title ?? "Untitled"}
          </p>
        </div>
        <span
          className={cn(
            "text-xs font-mono uppercase font-bold",
            SEVERITY_BADGE_COLOR[sev] ?? "text-muted-foreground",
          )}
        >
          {alert.severity.toUpperCase()}
        </span>
      </div>

      {/* Tree view */}
      <div className="border border-border rounded-md p-4 font-mono text-sm leading-relaxed bg-card">
        {/* Section heading */}
        <div className="text-primary font-bold mb-2 text-xs uppercase tracking-wider">
          Alert Detail
        </div>

        {/* Root */}
        <div className="text-foreground font-bold mb-1">alert/</div>

        {/* Core fields */}
        <TreeValue label="id" value={String(alert.id)} valueClassName="text-foreground" />
        <TreeValue
          label="severity"
          value={alert.severity.toUpperCase()}
          valueClassName={cn("font-bold", SEVERITY_COLOR[sev])}
        />
        <TreeValue
          label="detection"
          value={
            alert.detectionName
              ? `"${alert.detectionName}"`
              : "--"
          }
          valueClassName="text-primary"
        />
        <TreeValue label="trigger_type" value={alert.triggerType} valueClassName="text-muted-foreground" />
        <TreeValue
          label="status"
          value={alert.notificationStatus}
          valueClassName="text-muted-foreground"
        />
        <TreeValue
          label="created_at"
          value={alert.createdAt}
          valueClassName="text-foreground"
        />

        {alert.description && (
          <TreeValue
            label="description"
            value={`"${alert.description}"`}
            valueClassName="text-muted-foreground"
          />
        )}

        {/* Trigger data section */}
        {triggerEntries.length > 0 && (
          <TreeSection label="trigger_data" last={!hasNotifications}>
            {renderJsonTree(alert.triggerData, !hasNotifications)}
          </TreeSection>
        )}

        {/* Notification deliveries */}
        {hasNotifications && (
          <TreeSection label="notifications" last>
            {deliveries.length > 0
              ? deliveries.map((d, idx) => {
                  const isLast = idx === deliveries.length - 1;
                  const statusTag =
                    d.status === "sent"
                      ? "[OK]"
                      : d.status === "failed"
                        ? "[FAIL]"
                        : "[PEND]";
                  const statusColor =
                    NOTIF_STATUS_COLOR[d.status] ?? "text-muted-foreground";
                  const detail = d.error
                    ? ` (${d.error})`
                    : d.sentAt
                      ? " (sent \u2192)"
                      : "";

                  return (
                    <div key={String(d.id)} className="flex">
                      <span className="text-muted-foreground/50 select-none whitespace-pre">
                        {"    "}{isLast ? "└── " : "├── "}
                      </span>
                      <span className={cn("font-bold", statusColor)}>
                        {statusTag}
                      </span>
                      <span className="ml-1 text-foreground">
                        {d.channelType}
                      </span>
                      <span className="ml-1 text-muted-foreground">
                        → {d.channelId}
                      </span>
                      <span className="ml-1 text-muted-foreground text-xs">
                        {detail}
                      </span>
                    </div>
                  );
                })
              : alert.notifications.map(
                  (n: NotificationEntry, idx: number) => {
                    const isLast = idx === alert.notifications.length - 1;
                    const statusTag =
                      n.status === "sent"
                        ? "[OK]"
                        : n.status === "failed"
                          ? "[FAIL]"
                          : "[PEND]";
                    const statusColor =
                      NOTIF_STATUS_COLOR[n.status] ?? "text-muted-foreground";
                    return (
                      <div key={idx} className="flex">
                        <span className="text-muted-foreground/50 select-none whitespace-pre">
                          {"    "}{isLast ? "└── " : "├── "}
                        </span>
                        <span className={cn("font-bold", statusColor)}>
                          {statusTag}
                        </span>
                        <span className="ml-1 text-foreground">
                          {n.channelType}
                        </span>
                        <span className="ml-1 text-muted-foreground">
                          → {n.channelId}
                        </span>
                      </div>
                    );
                  },
                )}
          </TreeSection>
        )}
      </div>

      {/* Quick-nav to detection */}
      {alert.detectionId && (
        <div className="text-xs text-muted-foreground font-mono">
          $ cd /detections/{alert.detectionId.slice(0, 8)}...
          <Link
            href={`/detections/${alert.detectionId}`}
            className="ml-2 text-primary hover:underline"
          >
            [open]
          </Link>
        </div>
      )}
    </div>
  );
}
