"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types --------------------------------------------------------- */

interface ScoreDeduction {
  category: string;
  item: string;
  points: number;
  description: string;
  suppressed: boolean;
}

interface CertificateInfo {
  subject: string;
  issuer: string;
  expiresAt: string;
  issuedAt: string;
  sans: string[];
  chainValid: boolean;
  chainError: string | null;
  serialNumber: string;
  signatureAlgorithm: string;
}

interface TlsInfo {
  supportedVersions: string[];
  cipherSuite: string;
  keyExchange: string;
  protocolVersion: string;
  hasWeakCiphers: boolean;
  weakCiphers: string[];
}

interface DnsRecord {
  type: string;
  value: string;
  ttl: number;
  priority?: number;
}

interface DnsChange {
  id: string;
  recordType: string;
  oldValue: string;
  newValue: string;
  severity: string;
  detectedAt: string;
}

interface HttpHeader {
  name: string;
  present: boolean;
  value: string | null;
  expected: boolean;
}

interface InfraInfo {
  ip: string;
  geo: { country: string; city: string; region: string } | null;
  cloudProvider: string | null;
  openPorts: number[];
  asn: string | null;
  asnOrg: string | null;
}

interface WhoisInfo {
  registrar: string | null;
  createdDate: string | null;
  expiresDate: string | null;
  updatedDate: string | null;
  nameServers: string[];
  registrant: string | null;
}

interface ScanResult {
  id: string;
  status: "completed" | "failed" | "running" | "queued";
  startedAt: string;
  completedAt: string | null;
  steps: ScanStep[];
}

interface ScanStep {
  name: string;
  status: "passed" | "failed" | "warning" | "skipped" | "running";
  duration: number | null;
  message: string | null;
}

interface ScoreHistoryPoint {
  date: string;
  score: number;
  grade: string;
}

interface DnsHealthInfo {
  dnssecEnabled: boolean;
  dmarcRecord: string | null;
  dmarcPolicy: string | null;
  spfRecord: string | null;
  spfValid: boolean;
  caaRecords: string[];
  danglingCnames: string[];
  checkedAt: string;
}

interface ScanSchedule {
  enabled: boolean;
  scanIntervalHours: number;
  probeEnabled: boolean;
  probeIntervalMinutes: number;
}

interface ChildHost {
  id: string;
  hostname: string;
  score: number | null;
  grade: string | null;
  lastScanAt: string | null;
  certExpiry: string | null;
  status: string;
  source: string | null;
  createdAt: string;
}

interface HostDetail {
  id: string;
  hostname: string;
  isRoot?: boolean;
  score: number | null;
  grade: string | null;
  lastScanAt: string | null;
  status: string;
  certificate: CertificateInfo | null;
  tls: TlsInfo | null;
  dnsRecords: DnsRecord[];
  dnsChanges: DnsChange[];
  httpHeaders: HttpHeader[];
  infra: InfraInfo | null;
  whois: WhoisInfo | null;
  scoreDeductions: ScoreDeduction[];
  dnsHealth: DnsHealthInfo | null;
  scoreHistory: ScoreHistoryPoint[];
  recentScans: ScanResult[];
  schedule: ScanSchedule | null;
  createdAt: string;
}

/* -- helpers -------------------------------------------------------- */

const categoryLabel: Record<string, string> = {
  Infrastructure: "Infra",
  "HTTP Headers": "HTTP",
};

const gradeColor: Record<string, string> = {
  A: "text-primary",
  B: "text-primary/80",
  C: "text-warning",
  D: "text-warning/80",
  F: "text-destructive",
};

const gradeBg: Record<string, string> = {
  A: "border-primary/30",
  B: "border-primary/20",
  C: "border-warning/30",
  D: "border-warning/20",
  F: "border-destructive/30",
};

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const stepStatusIcon: Record<string, { icon: string; color: string }> = {
  passed: { icon: "[OK]", color: "text-primary" },
  failed: { icon: "[!!]", color: "text-destructive" },
  warning: { icon: "[!]", color: "text-warning" },
  skipped: { icon: "[--]", color: "text-muted-foreground" },
  running: { icon: "[..]", color: "text-warning" },
};

function formatDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString();
}

function formatDaysUntil(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  if (diffDays < 0) return `expired ${Math.abs(diffDays)}d ago`;
  if (diffDays === 0) return "expires today";
  return `${diffDays}d remaining`;
}

function formatCertExpiry(iso: string | null): { text: string; color: string } {
  if (!iso) return { text: "no cert", color: "text-muted-foreground" };
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  if (diffDays < 0) return { text: `expired ${Math.abs(diffDays)}d ago`, color: "text-destructive" };
  if (diffDays === 0) return { text: "expires today", color: "text-destructive" };
  if (diffDays <= 7) return { text: `${diffDays}d left`, color: "text-destructive" };
  if (diffDays <= 30) return { text: `${diffDays}d left`, color: "text-warning" };
  return { text: `${diffDays}d left`, color: "text-primary" };
}

/* -- page ----------------------------------------------------------- */

export default function HostDetailPage() {
  const params = useParams();
  const router = useRouter();
  const hostId = params.id as string;

  const [host, setHost] = useState<HostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [suppressLoading, setSuppressLoading] = useState<Record<string, boolean>>({});
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scanEnabled, setScanEnabled] = useState(true);
  const [scanInterval, setScanInterval] = useState(24);
  const [probeEnabled, setProbeEnabled] = useState(true);
  const [probeInterval, setProbeInterval] = useState(5);
  const [cdnOrigins, setCdnOrigins] = useState<Array<{ provider: string; recordType: string; recordValue: string; observedAt: string }>>([]);
  const [cdnOriginsLoaded, setCdnOriginsLoaded] = useState(false);
  const [subdomains, setSubdomains] = useState<ChildHost[]>([]);
  const [subdomainsLoaded, setSubdomainsLoaded] = useState(false);
  const [subdomainActionLoading, setSubdomainActionLoading] = useState<Record<string, boolean>>({});
  const { toast, toasts, dismiss } = useToast();

  // Confirm dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDesc, setConfirmDesc] = useState("");
  const [confirmResolve, setConfirmResolve] = useState<
    ((value: boolean) => void) | null
  >(null);

  function confirm(title: string, description: string): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmTitle(title);
      setConfirmDesc(description);
      setConfirmResolve(() => resolve);
      setConfirmOpen(true);
    });
  }

  function handleConfirmClose(result: boolean) {
    setConfirmOpen(false);
    confirmResolve?.(result);
  }

  // Active section (accordion-like)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["score", "dns-health", "certificate", "tls", "headers", "subdomains"]),
  );

  function toggleSection(section: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  const fetchHost = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ data: HostDetail }>(
        `/modules/infra/hosts/${hostId}`,
        { credentials: "include" },
      );
      setHost(res.data);
      setScanEnabled(res.data.schedule?.enabled ?? true);
      setScanInterval(res.data.schedule?.scanIntervalHours ?? 24);
      setProbeEnabled(res.data.schedule?.probeEnabled ?? true);
      setProbeInterval(res.data.schedule?.probeIntervalMinutes ?? 5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load host");
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  useEffect(() => {
    fetchHost();
  }, [fetchHost]);

  /* -- actions ------------------------------------------------------ */

  async function triggerScan() {
    setScanLoading(true);
    try {
      await apiFetch(`/modules/infra/hosts/${hostId}/scan`, {
        method: "POST",
        credentials: "include",
      });
      toast("Scan queued. Results will appear shortly.", "success");
      // Refresh after a delay
      setTimeout(fetchHost, 3000);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to trigger scan", "error");
    } finally {
      setScanLoading(false);
    }
  }

  async function toggleSuppression(deduction: ScoreDeduction) {
    const key = `${deduction.category}:${deduction.item}`;
    setSuppressLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const action = deduction.suppressed ? "unsuppress" : "suppress";
      await apiFetch(`/modules/infra/hosts/${hostId}/suppressions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: deduction.category,
          item: deduction.item,
          action,
        }),
      });
      setHost((prev) => {
        if (!prev) return prev;
        const updatedDeductions = prev.scoreDeductions.map((d) =>
          d.category === deduction.category && d.item === deduction.item
            ? { ...d, suppressed: !d.suppressed }
            : d,
        );
        const activePoints = updatedDeductions
          .filter((d) => !d.suppressed)
          .reduce((sum, d) => sum + d.points, 0);
        const newScore = Math.max(0, Math.min(100, 100 - activePoints));
        const newGrade =
          newScore >= 90 ? "A"
          : newScore >= 80 ? "B"
          : newScore >= 70 ? "C"
          : newScore >= 60 ? "D"
          : "F";
        return {
          ...prev,
          scoreDeductions: updatedDeductions,
          score: newScore,
          grade: newGrade,
        };
      });
      toast(`Finding ${action}ed.`);
    } catch {
      toast("Failed to update suppression.");
    } finally {
      setSuppressLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function saveSchedule() {
    setScheduleLoading(true);
    try {
      await apiFetch(`/modules/infra/hosts/${hostId}/schedule`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: scanEnabled,
          scanIntervalHours: scanInterval,
          probeEnabled,
          probeIntervalMinutes: probeInterval,
        }),
      });
      toast("Schedule updated.", "success");
      setScheduleModalOpen(false);
    } catch {
      toast("Failed to update schedule.");
    } finally {
      setScheduleLoading(false);
    }
  }

  async function removeHost() {
    const confirmed = await confirm(
      "Remove Host",
      `Are you sure you want to remove "${host?.hostname}"? All data will be permanently deleted.`,
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/modules/infra/hosts/${hostId}`, {
        method: "DELETE",
        credentials: "include",
      });
      toast("Host removed.");
      router.push("/infra/hosts");
    } catch {
      toast("Failed to remove host.");
    }
  }

  async function discoverSubdomains() {
    setDiscoverLoading(true);
    try {
      const res = await apiFetch<{ data: { discovered: number; newHosts: number } }>(
        `/modules/infra/hosts/${hostId}/discover`,
        { method: "POST", credentials: "include" },
      );
      toast(
        `Discovered ${res.data.discovered} subdomains (${res.data.newHosts} new)`,
      );
      if (res.data.newHosts > 0) {
        setSubdomainsLoaded(false);
        fetchSubdomains();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to discover subdomains");
    } finally {
      setDiscoverLoading(false);
    }
  }

  async function fetchCdnOrigins() {
    if (cdnOriginsLoaded) return;
    try {
      const res = await apiFetch<{ data: Array<{ provider: string; recordType: string; recordValue: string; observedAt: string }> }>(
        `/modules/infra/hosts/${hostId}/cdn-origins`,
        { credentials: "include" },
      );
      setCdnOrigins(res.data);
    } catch {
      // silently fail - section will show empty
    } finally {
      setCdnOriginsLoaded(true);
    }
  }

  async function fetchSubdomains() {
    try {
      const res = await apiFetch<{ data: ChildHost[] }>(
        `/modules/infra/hosts/${hostId}/subdomains`,
        { credentials: "include" },
      );
      setSubdomains(res.data);
    } catch {
      // silently fail
    } finally {
      setSubdomainsLoaded(true);
    }
  }

  async function scanSubdomain(child: ChildHost) {
    setSubdomainActionLoading((prev) => ({ ...prev, [`scan-${child.id}`]: true }));
    try {
      await apiFetch(`/modules/infra/hosts/${child.id}/scan`, {
        method: "POST",
        credentials: "include",
      });
      setSubdomains((prev) =>
        prev.map((h) => h.id === child.id ? { ...h, status: "scanning" } : h),
      );
      toast(`Scan queued for "${child.hostname}".`);
    } catch (err) {
      toast(err instanceof Error ? `Scan failed: ${err.message}` : "Failed to trigger scan");
    } finally {
      setSubdomainActionLoading((prev) => ({ ...prev, [`scan-${child.id}`]: false }));
    }
  }

  async function removeSubdomain(child: ChildHost) {
    const confirmed = await confirm(
      "Remove Subdomain",
      `Remove "${child.hostname}"? All scan data will be permanently deleted.`,
    );
    if (!confirmed) return;
    setSubdomainActionLoading((prev) => ({ ...prev, [`remove-${child.id}`]: true }));
    try {
      await apiFetch(`/modules/infra/hosts/${child.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      setSubdomains((prev) => prev.filter((h) => h.id !== child.id));
      toast(`Subdomain "${child.hostname}" removed.`);
    } catch {
      toast("Failed to remove subdomain.");
    } finally {
      setSubdomainActionLoading((prev) => ({ ...prev, [`remove-${child.id}`]: false }));
    }
  }

  /* -- section renderer --------------------------------------------- */

  function SectionHeader({
    id,
    title,
    command,
  }: {
    id: string;
    title: string;
    command: string;
  }) {
    const expanded = expandedSections.has(id);
    return (
      <button
        onClick={() => toggleSection(id)}
        className="w-full flex items-center justify-between py-2 text-left group"
      >
        <div>
          <span className="text-xs text-muted-foreground">{command}</span>
          <h3 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
            {title}
          </h3>
        </div>
        <span className="text-xs text-muted-foreground">
          {expanded ? "[-]" : "[+]"}
        </span>
      </button>
    );
  }

  /* -- render ------------------------------------------------------- */

  if (showLoading || loading) {
    return (
      <div className={showLoading ? "space-y-6" : "space-y-6 invisible"}>
        <div className="flex items-center gap-3">
          <div className="h-5 w-48 animate-pulse rounded bg-muted" />
        </div>
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
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-3 animate-pulse">
              <div className="h-3 bg-muted-foreground/20 rounded w-1/4" />
              <div className="h-3 bg-muted-foreground/20 rounded w-full" />
              <div className="h-3 bg-muted-foreground/20 rounded w-3/4" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error || !host) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">[ERR] {error ?? "Host not found"}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchHost}>
            $ retry
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/infra/hosts">{"<"} back to hosts</Link>
          </Button>
        </div>
      </div>
    );
  }

  const certExpiryDays = host.certificate?.expiresAt
    ? Math.floor(
        (new Date(host.certificate.expiresAt).getTime() - Date.now()) /
          86_400_000,
      )
    : null;

  return (
    <div className="space-y-6 animate-content-ready">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Schedule modal */}
      {scheduleModalOpen && createPortal(
        <div className="fixed inset-0 z-[150] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setScheduleModalOpen(false)}
          />
          <div className="relative z-10 w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg shadow-black/20 font-mono">
            <h2 className="text-sm font-bold text-primary mb-4">$ scan schedule</h2>

            <div className="space-y-4">
              {/* Master scan toggle */}
              <div className="flex items-center justify-between border border-border px-3 py-2">
                <span className="text-xs text-muted-foreground">--scanning</span>
                <button
                  onClick={() => setScanEnabled((v) => !v)}
                  className={cn("text-xs font-mono transition-colors", scanEnabled ? "text-primary" : "text-muted-foreground")}
                >
                  [{scanEnabled ? "enabled" : "disabled"}]
                </button>
              </div>

              <div className={cn("grid grid-cols-2 gap-3", !scanEnabled && "opacity-40 pointer-events-none")}>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">--scan-interval (hours)</label>
                  <div className="flex items-center gap-2 border border-border bg-background px-3 py-2 text-sm focus-within:border-primary transition-colors">
                    <span className="text-muted-foreground shrink-0">{">"}</span>
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={scanInterval}
                      onChange={(e) => setScanInterval(parseInt(e.target.value) || 1)}
                      className="w-full bg-transparent outline-none font-mono"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">--probe-interval (min)</label>
                  <div className="flex items-center gap-2 border border-border bg-background px-3 py-2 text-sm focus-within:border-primary transition-colors">
                    <span className="text-muted-foreground shrink-0">{">"}</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={probeInterval}
                      onChange={(e) => setProbeInterval(parseInt(e.target.value) || 1)}
                      className="w-full bg-transparent outline-none font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className={cn("flex items-center justify-between border border-border px-3 py-2", !scanEnabled && "opacity-40 pointer-events-none")}>
                <span className="text-xs text-muted-foreground">--uptime-probe</span>
                <button
                  onClick={() => setProbeEnabled((v) => !v)}
                  className={cn("text-xs font-mono transition-colors", probeEnabled ? "text-primary" : "text-muted-foreground")}
                >
                  [{probeEnabled ? "enabled" : "disabled"}]
                </button>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                setScheduleModalOpen(false);
                setScanEnabled(host?.schedule?.enabled ?? true);
                setScanInterval(host?.schedule?.scanIntervalHours ?? 24);
                setProbeEnabled(host?.schedule?.probeEnabled ?? true);
                setProbeInterval(host?.schedule?.probeIntervalMinutes ?? 5);
              }}>
                [cancel]
              </Button>
              <Button size="sm" disabled={scheduleLoading} onClick={saveSchedule}>
                {scheduleLoading ? "> saving..." : "$ save"}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        description={confirmDesc}
        onClose={handleConfirmClose}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/infra/hosts"
              className="text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              hosts/
            </Link>
            <span className="text-xs text-muted-foreground">/</span>
          </div>
          <h1 className="text-lg text-primary text-glow">
            $ infra inspect {host.hostname}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} status: [{host.status}] | added{" "}
            {new Date(host.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={scanLoading}
            onClick={triggerScan}
          >
            {scanLoading ? "> scanning..." : "$ scan now"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={discoverLoading}
            onClick={discoverSubdomains}
          >
            {discoverLoading ? "> discovering..." : "$ discover subdomains"}
          </Button>
          <button
            onClick={removeHost}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            [remove]
          </button>
        </div>
      </div>

      {/* Score card + quick stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Grade card */}
        <Card className={cn(gradeBg[host.grade ?? ""])}>
          <CardContent className="p-4 flex items-center gap-4">
            <div
              className={cn(
                "text-5xl font-black",
                gradeColor[host.grade ?? ""] ?? "text-muted-foreground",
              )}
            >
              {host.grade ?? "?"}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">SECURITY SCORE</p>
              <p
                className={cn(
                  "text-2xl font-bold",
                  gradeColor[host.grade ?? ""] ?? "text-muted-foreground",
                )}
              >
                {host.score != null ? `${host.score}/100` : "--"}
              </p>
              <p className="text-xs text-muted-foreground">
                last scan: {formatDate(host.lastScanAt)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Cert status */}
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">CERTIFICATE</p>
            {host.certificate ? (
              <>
                <p
                  className={cn(
                    "mt-1 text-lg font-bold",
                    certExpiryDays !== null && certExpiryDays <= 7
                      ? "text-destructive"
                      : certExpiryDays !== null && certExpiryDays <= 30
                        ? "text-warning"
                        : "text-primary",
                  )}
                >
                  {formatDaysUntil(host.certificate.expiresAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  chain: {host.certificate.chainValid ? "[OK]" : "[!!] invalid"}
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">no cert data</p>
            )}
          </CardContent>
        </Card>

        {/* Scan schedule */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <p className="text-xs text-muted-foreground">SCAN SCHEDULE</p>
              <button
                onClick={() => setScheduleModalOpen(true)}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                [edit]
              </button>
            </div>
            <div className="mt-1 space-y-1 text-xs font-mono">
              <p>
                <span className="text-muted-foreground">scan: </span>
                <span className={host.schedule?.enabled === false ? "text-muted-foreground" : "text-primary"}>
                  {host.schedule?.enabled === false ? "off" : `every ${host.schedule?.scanIntervalHours ?? 24}h`}
                </span>
              </p>
              <p>
                <span className="text-muted-foreground">probe: </span>
                <span className={host.schedule?.probeEnabled === false ? "text-muted-foreground" : "text-foreground"}>
                  {host.schedule?.probeEnabled === false ? "off" : `every ${host.schedule?.probeIntervalMinutes ?? 5}m`}
                </span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Infra quick */}
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">INFRASTRUCTURE</p>
            {host.infra ? (
              <>
                <p className="mt-1 text-lg font-bold text-foreground">
                  {host.infra.ip}
                </p>
                <p className="text-xs text-muted-foreground">
                  {host.infra.cloudProvider ?? "unknown"} |{" "}
                  {host.infra.geo
                    ? `${host.infra.geo.city}, ${host.infra.geo.country}`
                    : "unknown location"}
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">no infra data</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ============================================================= */}
      {/* Score & Deductions */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="score"
            title="Score Deductions"
            command="$ infra score --breakdown"
          />
        </CardHeader>
        {expandedSections.has("score") && (
          <CardContent className="pt-3">
            {/* Deductions table */}
            {(host.scoreDeductions ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {">"} no deductions -- perfect score
              </p>
            ) : (
              <div className="space-y-1">
                <div className="grid grid-cols-[100px_minmax(120px,1fr)_50px_minmax(150px,2fr)_80px] gap-x-3 border-b border-border px-2 py-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                  <span>Category</span>
                  <span>Item</span>
                  <span>Pts</span>
                  <span>Description</span>
                  <span className="text-right">Action</span>
                </div>
                {(host.scoreDeductions ?? []).map((d) => {
                  const key = `${d.category}:${d.item}`;
                  const busy = suppressLoading[key] ?? false;
                  return (
                    <div
                      key={key}
                      className={cn(
                        "grid grid-cols-[100px_minmax(120px,1fr)_50px_minmax(150px,2fr)_80px] gap-x-3 px-2 py-1.5 text-xs border border-transparent hover:border-border hover:bg-muted/30 transition-colors",
                        d.suppressed && "opacity-50",
                      )}
                    >
                      <span className="text-primary">[{categoryLabel[d.category] ?? d.category}]</span>
                      <span className="text-foreground truncate">{d.item}</span>
                      <span className="text-destructive font-mono">
                        -{d.points}
                      </span>
                      <span className="text-muted-foreground truncate">
                        {d.description}
                      </span>
                      <span className="text-right">
                        <button
                          disabled={busy}
                          onClick={() => toggleSuppression(d)}
                          className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                        >
                          {busy
                            ? "..."
                            : d.suppressed
                              ? "[unsuppress]"
                              : "[suppress]"}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* DNS & Email Security */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="dns-health"
            title="Email & DNS Security"
            command="$ dig TXT _dmarc SPF DNSKEY"
          />
        </CardHeader>
        {expandedSections.has("dns-health") && (
          <CardContent className="pt-3">
            {!host.dnsHealth ? (
              <p className="text-xs text-muted-foreground">
                {">"} no dns health data — run a full scan
              </p>
            ) : (
              <div className="space-y-3 text-xs font-mono">
                {/* DNSSEC */}
                <div className="flex items-start gap-3 border-b border-border/50 pb-3">
                  <span className="w-20 shrink-0 text-muted-foreground">DNSSEC</span>
                  <span className={host.dnsHealth.dnssecEnabled ? "text-primary" : "text-destructive"}>
                    {host.dnsHealth.dnssecEnabled ? "[OK] enabled" : "[!!] not enabled"}
                  </span>
                </div>

                {/* DMARC */}
                <div className="flex items-start gap-3 border-b border-border/50 pb-3">
                  <span className="w-20 shrink-0 text-muted-foreground">DMARC</span>
                  <div className="min-w-0">
                    {!host.dnsHealth.dmarcRecord ? (
                      <span className="text-destructive">[!!] no DMARC record</span>
                    ) : (
                      <>
                        <span className={host.dnsHealth.dmarcPolicy === "none" ? "text-warning" : "text-primary"}>
                          {host.dnsHealth.dmarcPolicy === "none"
                            ? "[!] p=none (monitoring only)"
                            : host.dnsHealth.dmarcPolicy === "quarantine"
                              ? "[~] p=quarantine"
                              : "[OK] p=reject"}
                        </span>
                        <p className="text-muted-foreground mt-1 break-all">{host.dnsHealth.dmarcRecord}</p>
                      </>
                    )}
                  </div>
                </div>

                {/* SPF */}
                <div className="flex items-start gap-3 border-b border-border/50 pb-3">
                  <span className="w-20 shrink-0 text-muted-foreground">SPF</span>
                  <div className="min-w-0">
                    {!host.dnsHealth.spfRecord ? (
                      <span className="text-destructive">[!!] no SPF record</span>
                    ) : (
                      <>
                        <span className={host.dnsHealth.spfValid ? "text-primary" : "text-warning"}>
                          {host.dnsHealth.spfValid ? "[OK] valid" : "[!] issues detected"}
                        </span>
                        <p className="text-muted-foreground mt-1 break-all">{host.dnsHealth.spfRecord}</p>
                      </>
                    )}
                  </div>
                </div>

                {/* CAA */}
                <div className="flex items-start gap-3 border-b border-border/50 pb-3">
                  <span className="w-20 shrink-0 text-muted-foreground">CAA</span>
                  <div className="min-w-0">
                    {host.dnsHealth.caaRecords.length === 0 ? (
                      <span className="text-warning">[!] no CAA records — any CA can issue certs</span>
                    ) : (
                      <>
                        <span className="text-primary">[OK] {host.dnsHealth.caaRecords.length} record{host.dnsHealth.caaRecords.length !== 1 ? "s" : ""}</span>
                        <div className="mt-1 space-y-0.5">
                          {host.dnsHealth.caaRecords.map((r, i) => (
                            <p key={i} className="text-muted-foreground break-all">{r}</p>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Dangling CNAMEs */}
                <div className="flex items-start gap-3">
                  <span className="w-20 shrink-0 text-muted-foreground">Dangling</span>
                  <div className="min-w-0">
                    {host.dnsHealth.danglingCnames.length === 0 ? (
                      <span className="text-primary">[OK] no dangling CNAMEs</span>
                    ) : (
                      <>
                        <span className="text-destructive">[!!] {host.dnsHealth.danglingCnames.length} dangling CNAME{host.dnsHealth.danglingCnames.length !== 1 ? "s" : ""} (takeover risk)</span>
                        <div className="mt-1 space-y-0.5">
                          {host.dnsHealth.danglingCnames.map((c, i) => (
                            <p key={i} className="text-destructive/80 break-all">{c}</p>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* Certificate Info */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="certificate"
            title="Certificate"
            command="$ openssl s_client -connect"
          />
        </CardHeader>
        {expandedSections.has("certificate") && (
          <CardContent className="pt-3">
            {host.certificate ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">subject: </span>
                    <span className="text-foreground">
                      {host.certificate.subject}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">issuer: </span>
                    <span className="text-foreground">
                      {host.certificate.issuer}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">issued: </span>
                    <span className="text-foreground">
                      {formatDate(host.certificate.issuedAt)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">expires: </span>
                    <span
                      className={cn(
                        certExpiryDays !== null && certExpiryDays <= 7
                          ? "text-destructive"
                          : certExpiryDays !== null && certExpiryDays <= 30
                            ? "text-warning"
                            : "text-foreground",
                      )}
                    >
                      {formatDate(host.certificate.expiresAt)} (
                      {formatDaysUntil(host.certificate.expiresAt)})
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">serial: </span>
                    <span className="text-foreground font-mono">
                      {host.certificate.serialNumber}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">algorithm: </span>
                    <span className="text-foreground">
                      {host.certificate.signatureAlgorithm}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">chain: </span>
                    <span
                      className={
                        host.certificate.chainValid
                          ? "text-primary"
                          : "text-destructive"
                      }
                    >
                      {host.certificate.chainValid
                        ? "[OK] valid"
                        : `[!!] ${host.certificate.chainError ?? "invalid"}`}
                    </span>
                  </div>
                </div>

                {/* SANs */}
                {host.certificate.sans.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">
                      Subject Alternative Names ({host.certificate.sans.length}):
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {host.certificate.sans.map((san) => (
                        <span
                          key={san}
                          className="text-xs text-foreground bg-muted/30 border border-border px-1.5 py-0.5"
                        >
                          {san}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no certificate data available
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* TLS Analysis */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="tls"
            title="TLS Analysis"
            command="$ nmap --script ssl-enum-ciphers"
          />
        </CardHeader>
        {expandedSections.has("tls") && (
          <CardContent className="pt-3">
            {host.tls ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">protocol: </span>
                    <span className="text-foreground">
                      {host.tls.protocolVersion}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">cipher: </span>
                    <span className="text-foreground font-mono">
                      {host.tls.cipherSuite}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">key exchange: </span>
                    <span className="text-foreground">
                      {host.tls.keyExchange}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">weak ciphers: </span>
                    <span
                      className={
                        host.tls.hasWeakCiphers
                          ? "text-destructive"
                          : "text-primary"
                      }
                    >
                      {host.tls.hasWeakCiphers
                        ? `[!!] ${host.tls.weakCiphers.length} found`
                        : "[OK] none"}
                    </span>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    supported versions:
                  </p>
                  <div className="flex gap-2">
                    {host.tls.supportedVersions.map((v) => (
                      <span
                        key={v}
                        className={cn(
                          "text-xs px-2 py-0.5 border",
                          v.includes("1.0") || v.includes("1.1")
                            ? "text-destructive border-destructive/30"
                            : "text-primary border-primary/30",
                        )}
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                </div>

                {host.tls.hasWeakCiphers && host.tls.weakCiphers.length > 0 && (
                  <div>
                    <p className="text-xs text-destructive mb-1">
                      [!!] weak ciphers detected:
                    </p>
                    {host.tls.weakCiphers.map((c) => (
                      <p key={c} className="text-xs text-muted-foreground font-mono">
                        - {c}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no TLS data available
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* DNS Records */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="dns"
            title="DNS Records"
            command="$ dig +short ANY"
          />
        </CardHeader>
        {expandedSections.has("dns") && (
          <CardContent className="pt-3">
            {(host.dnsRecords ?? []).length > 0 ? (
              <div>
                <div className="grid grid-cols-[60px_minmax(150px,1fr)_80px_60px] gap-x-3 border-b border-border px-2 py-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                  <span>Type</span>
                  <span>Value</span>
                  <span>TTL</span>
                  <span>Priority</span>
                </div>
                {(host.dnsRecords ?? []).map((r, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[60px_minmax(150px,1fr)_80px_60px] gap-x-3 px-2 py-1.5 text-xs border border-transparent hover:border-border hover:bg-muted/30 transition-colors"
                  >
                    <span className="text-primary font-mono">{r.type}</span>
                    <span className="text-foreground font-mono truncate">
                      {r.value}
                    </span>
                    <span className="text-muted-foreground">{r.ttl}s</span>
                    <span className="text-muted-foreground">
                      {r.priority ?? "--"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no DNS records found
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* DNS Changes History */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="dns-changes"
            title="DNS Changes"
            command="$ infra dns --changes"
          />
        </CardHeader>
        {expandedSections.has("dns-changes") && (
          <CardContent className="pt-3">
            {(host.dnsChanges ?? []).length > 0 ? (
              <div>
                <div className="grid grid-cols-[70px_60px_minmax(100px,1fr)_minmax(100px,1fr)_120px] gap-x-3 border-b border-border px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <span>Severity</span>
                  <span>Type</span>
                  <span>Old Value</span>
                  <span>New Value</span>
                  <span>Detected</span>
                </div>
                {(host.dnsChanges ?? []).map((change) => (
                  <div
                    key={change.id}
                    className="grid grid-cols-[70px_60px_minmax(100px,1fr)_minmax(100px,1fr)_120px] items-center gap-x-3 border border-transparent px-2 py-1.5 text-xs transition-colors hover:border-border hover:bg-muted/30"
                  >
                    <span
                      className={cn(
                        "font-mono",
                        severityColor[change.severity] ?? "text-muted-foreground",
                      )}
                    >
                      [{change.severity}]
                    </span>
                    <span className="text-primary font-mono">
                      {change.recordType}
                    </span>
                    <span className="text-muted-foreground font-mono truncate line-through">
                      {change.oldValue || "(none)"}
                    </span>
                    <span className="text-foreground font-mono truncate">
                      {change.newValue || "(removed)"}
                    </span>
                    <span className="text-muted-foreground">
                      {formatDate(change.detectedAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no DNS changes detected
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* HTTP Security Headers */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="headers"
            title="HTTP Security Headers"
            command="$ curl -I --head"
          />
        </CardHeader>
        {expandedSections.has("headers") && (
          <CardContent className="pt-3">
            {(host.httpHeaders ?? []).length > 0 ? (
              <div className="space-y-1">
                {(host.httpHeaders ?? []).map((h) => (
                  <div
                    key={h.name}
                    className="flex items-center gap-3 px-2 py-1.5 text-xs border border-transparent hover:border-border hover:bg-muted/30 transition-colors"
                  >
                    <span
                      className={cn(
                        "shrink-0 w-6 font-mono",
                        h.present && h.expected
                          ? "text-primary"
                          : !h.present && h.expected
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    >
                      {h.present ? "[+]" : "[-]"}
                    </span>
                    <span
                      className={cn(
                        "w-48 shrink-0 font-mono",
                        h.present ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {h.name}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {h.value ?? (h.expected ? "MISSING" : "--")}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no header data available
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* Infrastructure Info */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="infra"
            title="Infrastructure"
            command="$ whois && geoiplookup"
          />
        </CardHeader>
        {expandedSections.has("infra") && (
          <CardContent className="pt-3">
            {host.infra ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <div>
                  <span className="text-muted-foreground">ip: </span>
                  <span className="text-foreground font-mono">
                    {host.infra.ip}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">provider: </span>
                  <span className="text-foreground">
                    {host.infra.cloudProvider ?? "unknown"}
                  </span>
                </div>
                {host.infra.geo && (
                  <>
                    <div>
                      <span className="text-muted-foreground">country: </span>
                      <span className="text-foreground">
                        {host.infra.geo.country}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">city: </span>
                      <span className="text-foreground">
                        {host.infra.geo.city}, {host.infra.geo.region}
                      </span>
                    </div>
                  </>
                )}
                <div>
                  <span className="text-muted-foreground">ASN: </span>
                  <span className="text-foreground font-mono">
                    {host.infra.asn ?? "--"}{" "}
                    {host.infra.asnOrg ? `(${host.infra.asnOrg})` : ""}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">open ports: </span>
                  <span className="text-foreground font-mono">
                    {host.infra.openPorts.length > 0
                      ? host.infra.openPorts.join(", ")
                      : "none detected"}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no infrastructure data available
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* WHOIS */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="whois"
            title="WHOIS Information"
            command="$ whois"
          />
        </CardHeader>
        {expandedSections.has("whois") && (
          <CardContent className="pt-3">
            {host.whois ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                <div>
                  <span className="text-muted-foreground">registrar: </span>
                  <span className="text-foreground">
                    {host.whois.registrar ?? "--"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">registrant: </span>
                  <span className="text-foreground">
                    {host.whois.registrant ?? "--"}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">created: </span>
                  <span className="text-foreground">
                    {formatDate(host.whois.createdDate)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">expires: </span>
                  <span className="text-foreground">
                    {formatDate(host.whois.expiresDate)}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">updated: </span>
                  <span className="text-foreground">
                    {formatDate(host.whois.updatedDate)}
                  </span>
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">name servers: </span>
                  <span className="text-foreground font-mono">
                    {host.whois.nameServers.length > 0
                      ? host.whois.nameServers.join(", ")
                      : "--"}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no WHOIS data available
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* Recent Scans */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="scans"
            title="Recent Scans"
            command="$ infra scans --recent"
          />
        </CardHeader>
        {expandedSections.has("scans") && (
          <CardContent className="pt-3">
            {(host.recentScans ?? []).length > 0 ? (
              <div className="space-y-3">
                {(host.recentScans ?? []).map((scan) => (
                  <div
                    key={scan.id}
                    className="border border-border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "font-mono",
                            scan.status === "completed"
                              ? "text-primary"
                              : scan.status === "failed"
                                ? "text-destructive"
                                : scan.status === "running"
                                  ? "text-warning"
                                  : "text-muted-foreground",
                          )}
                        >
                          [{scan.status}]
                        </span>
                        <span className="text-muted-foreground">
                          started: {formatDate(scan.startedAt)}
                        </span>
                        {scan.completedAt && (
                          <span className="text-muted-foreground">
                            | completed: {formatDate(scan.completedAt)}
                          </span>
                        )}
                      </div>
                      <span className="text-muted-foreground font-mono">
                        {scan.id.slice(0, 8)}
                      </span>
                    </div>

                    {/* Steps */}
                    {scan.steps.length > 0 && (
                      <div className="space-y-0.5">
                        {scan.steps.map((step, i) => {
                          const si =
                            stepStatusIcon[step.status] ?? stepStatusIcon.skipped;
                          return (
                            <div
                              key={i}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span className={cn("font-mono w-8", si.color)}>
                                {si.icon}
                              </span>
                              <span className="text-foreground">{step.name}</span>
                              {step.duration !== null && (
                                <span className="text-muted-foreground ml-auto">
                                  {step.duration}ms
                                </span>
                              )}
                              {step.message && (
                                <span className="text-muted-foreground truncate ml-2">
                                  {step.message}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no scan history available
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* CDN Origins */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="cdn-origins"
            title="CDN Origins"
            command="$ infra cdn --origins"
          />
        </CardHeader>
        {expandedSections.has("cdn-origins") && (
          <CardContent className="pt-3">
            {!cdnOriginsLoaded ? (
              <div>
                <button
                  onClick={fetchCdnOrigins}
                  className="text-xs text-primary hover:underline"
                >
                  $ load cdn origins
                </button>
              </div>
            ) : cdnOrigins.length > 0 ? (
              <div className="space-y-2">
                {cdnOrigins.map((origin, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-2 py-1.5 text-xs border border-transparent hover:border-border hover:bg-muted/30 transition-colors"
                  >
                    <span className="text-primary font-mono shrink-0">
                      [{origin.provider}]
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {origin.recordType}:
                    </span>
                    <span className="text-foreground font-mono">
                      {origin.recordValue}
                    </span>
                    <span className="ml-auto text-muted-foreground shrink-0">
                      observed {new Date(origin.observedAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no CDN origins configured or detected
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* Score History */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="score-history"
            title="Score History"
            command="$ infra score --history"
          />
        </CardHeader>
        {expandedSections.has("score-history") && (
          <CardContent className="pt-3">
            {(host.scoreHistory ?? []).length > 0 ? (
              <div className="space-y-1">
                {(host.scoreHistory ?? []).slice(0, 10).map((point, i) => {
                  const barWidth = Math.max(1, Math.floor(point.score / 5));
                  const bar = "\u2593".repeat(barWidth);
                  return (
                    <div key={i} className="flex items-center gap-3 text-xs font-mono">
                      <span className={cn(
                        "w-8 text-right",
                        gradeColor[point.grade] ?? "text-muted-foreground",
                      )}>
                        {point.score}
                      </span>
                      <span className={cn(
                        gradeColor[point.grade] ?? "text-muted-foreground",
                      )}>
                        {bar}
                      </span>
                      <span className="text-muted-foreground">
                        {point.grade}
                      </span>
                      <span className="text-muted-foreground ml-auto">
                        {new Date(point.date).toLocaleDateString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {">"} no score history available
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ============================================================= */}
      {/* Subdomains */}
      {/* ============================================================= */}
      <Card>
        <CardHeader className="pb-0">
          <SectionHeader
            id="subdomains"
            title="Subdomains"
            command="$ infra subdomains --list"
          />
        </CardHeader>
        {expandedSections.has("subdomains") && (
          <CardContent className="pt-3">
            {!subdomainsLoaded ? (
              <div>
                <button
                  onClick={fetchSubdomains}
                  className="text-xs text-primary hover:underline"
                >
                  $ load subdomains
                </button>
              </div>
            ) : subdomains.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {">"} no subdomains discovered yet — use{" "}
                <button
                  onClick={discoverSubdomains}
                  disabled={discoverLoading}
                  className="text-primary hover:underline disabled:opacity-50"
                >
                  $ discover subdomains
                </button>
              </p>
            ) : (
              <div className="space-y-0">
                <div className="grid grid-cols-[minmax(160px,2fr)_50px_60px_90px_90px_1fr] gap-x-3 border-b border-border px-2 py-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                  <span>Hostname</span>
                  <span>Grade</span>
                  <span>Status</span>
                  <span>Last Scan</span>
                  <span>Cert</span>
                  <span className="text-right">Actions</span>
                </div>
                <p className="px-2 pt-1.5 text-xs text-muted-foreground">
                  {subdomains.length} subdomain{subdomains.length !== 1 ? "s" : ""}
                </p>
                {subdomains.map((child) => {
                  const cert = formatCertExpiry(child.certExpiry);
                  const scanBusy = subdomainActionLoading[`scan-${child.id}`] ?? false;
                  const removeBusy = subdomainActionLoading[`remove-${child.id}`] ?? false;
                  return (
                    <div
                      key={child.id}
                      className="group grid grid-cols-[minmax(160px,2fr)_50px_60px_90px_90px_1fr] items-center gap-x-3 border border-transparent px-2 py-1.5 text-xs transition-colors hover:border-border hover:bg-muted/30"
                    >
                      <Link
                        href={`/infra/hosts/${child.id}`}
                        className="truncate text-foreground group-hover:text-primary font-mono transition-colors"
                      >
                        └ {child.hostname}
                      </Link>
                      <span>
                        {child.grade ? (
                          <span
                            className={cn(
                              "inline-flex items-center justify-center w-6 h-6 text-xs font-bold border",
                              child.grade === "A" ? "bg-primary/10 border-primary/30 text-primary" :
                              child.grade === "B" ? "bg-primary/5 border-primary/20 text-primary/80" :
                              child.grade === "C" ? "bg-warning/10 border-warning/30 text-warning" :
                              child.grade === "D" ? "bg-warning/5 border-warning/20 text-warning/80" :
                              "bg-destructive/10 border-destructive/30 text-destructive",
                            )}
                          >
                            {child.grade}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">--</span>
                        )}
                      </span>
                      <span className={cn(
                        "font-mono",
                        child.status === "active" ? "text-primary" :
                        child.status === "scanning" ? "text-warning" :
                        child.status === "error" ? "text-destructive" : "text-muted-foreground",
                      )}>
                        [{child.status}]
                      </span>
                      <span className="text-muted-foreground">
                        {child.lastScanAt
                          ? (() => {
                              const diffMins = Math.floor((Date.now() - new Date(child.lastScanAt).getTime()) / 60_000);
                              if (diffMins < 1) return "just now";
                              if (diffMins < 60) return `${diffMins}m ago`;
                              const h = Math.floor(diffMins / 60);
                              if (h < 24) return `${h}h ago`;
                              return `${Math.floor(h / 24)}d ago`;
                            })()
                          : "never"}
                      </span>
                      <span className={cn("", cert.color)}>{cert.text}</span>
                      <span className="flex items-center justify-end gap-2">
                        <button
                          disabled={scanBusy || child.status === "scanning"}
                          onClick={() => scanSubdomain(child)}
                          className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                        >
                          {scanBusy ? "..." : "[scan]"}
                        </button>
                        <Link
                          href={`/infra/hosts/${child.id}`}
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          [view]
                        </Link>
                        <button
                          disabled={removeBusy}
                          onClick={() => removeSubdomain(child)}
                          className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        >
                          {removeBusy ? "..." : "[remove]"}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        )}
      </Card>

    </div>
  );
}
