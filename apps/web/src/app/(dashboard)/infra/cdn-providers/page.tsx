"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types --------------------------------------------------------- */

interface CdnProvider {
  id: string;
  provider: string;
  displayName: string;
  hostPattern: string;
  isValid: boolean;
  lastValidatedAt: string | null;
  createdAt: string;
}

interface Host {
  id: string;
  hostname: string;
}

interface ProxyCheckResult {
  hostId: string;
  hostname: string;
  isProxied: boolean;
  provider: string;
  detectionMethod: string;
  hasProviderConfig: boolean;
}

type ProviderType = "cloudflare" | "cloudfront";

/* -- page ----------------------------------------------------------- */

export default function CdnProvidersPage() {
  const [providers, setProviders] = useState<CdnProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const { toast } = useToast();

  // Add form state
  const [showAdd, setShowAdd] = useState(false);
  const [addProvider, setAddProvider] = useState<ProviderType>("cloudflare");
  const [addDisplayName, setAddDisplayName] = useState("");
  const [addHostPattern, setAddHostPattern] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Cloudflare credentials
  const [cfApiToken, setCfApiToken] = useState("");
  const [cfAccountId, setCfAccountId] = useState("");

  // CloudFront credentials
  const [awsAccessKey, setAwsAccessKey] = useState("");
  const [awsSecretKey, setAwsSecretKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");

  // Proxy check state
  const [showProxyCheck, setShowProxyCheck] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());
  const [proxyResults, setProxyResults] = useState<ProxyCheckResult[]>([]);
  const [proxyChecking, setProxyChecking] = useState(false);

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

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ data: CdnProvider[] }>(
        "/modules/infra/cdn-providers",
        { credentials: "include" },
      );
      setProviders(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load CDN providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  /* -- actions ------------------------------------------------------ */

  async function handleAddProvider(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);

    if (!addDisplayName.trim()) {
      setAddError("Display name is required.");
      return;
    }

    let credentials: Record<string, string>;
    if (addProvider === "cloudflare") {
      if (!cfApiToken.trim() || !cfAccountId.trim()) {
        setAddError("API Token and Account ID are required for Cloudflare.");
        return;
      }
      credentials = { apiToken: cfApiToken, accountId: cfAccountId };
    } else {
      if (!awsAccessKey.trim() || !awsSecretKey.trim()) {
        setAddError("Access Key ID and Secret Access Key are required for CloudFront.");
        return;
      }
      credentials = { accessKeyId: awsAccessKey, secretAccessKey: awsSecretKey, region: awsRegion };
    }

    setAddLoading(true);
    try {
      const res = await apiFetch<{ data: CdnProvider }>("/modules/infra/cdn-providers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: addProvider,
          displayName: addDisplayName.trim(),
          credentials,
          hostPattern: addHostPattern.trim() || undefined,
        }),
      });
      setProviders((prev) => [...prev, res.data]);
      setShowAdd(false);
      resetAddForm();
      toast("CDN provider added.");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add CDN provider");
    } finally {
      setAddLoading(false);
    }
  }

  function resetAddForm() {
    setAddDisplayName("");
    setAddHostPattern("");
    setCfApiToken("");
    setCfAccountId("");
    setAwsAccessKey("");
    setAwsSecretKey("");
    setAwsRegion("us-east-1");
    setAddError(null);
  }

  async function validateProvider(provider: CdnProvider) {
    setActionLoading((prev) => ({ ...prev, [`validate-${provider.id}`]: true }));
    try {
      const res = await apiFetch<{ data: { valid: boolean; message: string } }>(
        `/modules/infra/cdn-providers/${provider.id}/validate`,
        { method: "POST", credentials: "include" },
      );
      setProviders((prev) =>
        prev.map((p) =>
          p.id === provider.id
            ? { ...p, isValid: res.data.valid, lastValidatedAt: new Date().toISOString() }
            : p,
        ),
      );
      toast(res.data.valid ? "Validation passed." : `Validation failed: ${res.data.message}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setActionLoading((prev) => ({ ...prev, [`validate-${provider.id}`]: false }));
    }
  }

  async function removeProvider(provider: CdnProvider) {
    const confirmed = await confirm(
      "Remove CDN Provider",
      `Remove "${provider.displayName}"? This cannot be undone.`,
    );
    if (!confirmed) return;
    setActionLoading((prev) => ({ ...prev, [provider.id]: true }));
    try {
      await apiFetch(`/modules/infra/cdn-providers/${provider.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      setProviders((prev) => prev.filter((p) => p.id !== provider.id));
      toast("CDN provider removed.");
    } catch {
      toast("Failed to remove CDN provider.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [provider.id]: false }));
    }
  }

  async function loadHostsForProxyCheck() {
    setHostsLoading(true);
    try {
      const res = await apiFetch<{ data: Host[] }>(
        "/modules/infra/hosts?limit=100",
        { credentials: "include" },
      );
      setHosts(res.data);
    } catch {
      toast("Failed to load hosts.");
    } finally {
      setHostsLoading(false);
    }
  }

  async function runProxyCheck() {
    if (selectedHostIds.size === 0) return;
    setProxyChecking(true);
    try {
      const res = await apiFetch<{ data: ProxyCheckResult[] }>(
        "/modules/infra/cdn-providers/check-proxy",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostIds: Array.from(selectedHostIds) }),
        },
      );
      setProxyResults(res.data);
      toast(`Checked ${res.data.length} hosts.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Proxy check failed");
    } finally {
      setProxyChecking(false);
    }
  }

  function toggleHostSelection(id: string) {
    setSelectedHostIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllHosts() {
    if (selectedHostIds.size === hosts.length) {
      setSelectedHostIds(new Set());
    } else {
      setSelectedHostIds(new Set(hosts.map((h) => h.id)));
    }
  }

  /* -- render ------------------------------------------------------- */

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        description={confirmDesc}
        onClose={handleConfirmClose}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ infra cdn-providers
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} CDN provider configurations and proxy detection
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/infra">{"<"} overview</Link>
          </Button>
          <Button onClick={() => { setShowAdd(!showAdd); if (showAdd) resetAddForm(); }}>
            {showAdd ? "[cancel]" : "+ Add Provider"}
          </Button>
        </div>
      </div>

      {/* Add provider form */}
      {showAdd && (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              $ infra cdn-providers add
            </p>
            <form onSubmit={handleAddProvider} className="space-y-4">
              {/* Provider toggle */}
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">--provider</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAddProvider("cloudflare")}
                    className={cn(
                      "px-3 py-1 text-xs border transition-colors",
                      addProvider === "cloudflare"
                        ? "border-primary text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    [cloudflare]
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddProvider("cloudfront")}
                    className={cn(
                      "px-3 py-1 text-xs border transition-colors",
                      addProvider === "cloudfront"
                        ? "border-primary text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    [cloudfront]
                  </button>
                </div>
              </div>

              {/* Display name */}
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">--display-name</label>
                <Input
                  type="text"
                  placeholder="My Cloudflare Account"
                  value={addDisplayName}
                  onChange={(e) => setAddDisplayName(e.target.value)}
                />
              </div>

              {/* Provider-specific credentials */}
              {addProvider === "cloudflare" ? (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">--api-token</label>
                    <Input
                      type="password"
                      placeholder="Cloudflare API Token"
                      value={cfApiToken}
                      onChange={(e) => setCfApiToken(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">--account-id</label>
                    <Input
                      type="text"
                      placeholder="Cloudflare Account ID"
                      value={cfAccountId}
                      onChange={(e) => setCfAccountId(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">--access-key-id</label>
                    <Input
                      type="text"
                      placeholder="AWS Access Key ID"
                      value={awsAccessKey}
                      onChange={(e) => setAwsAccessKey(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">--secret-access-key</label>
                    <Input
                      type="password"
                      placeholder="AWS Secret Access Key"
                      value={awsSecretKey}
                      onChange={(e) => setAwsSecretKey(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">--region</label>
                    <Input
                      type="text"
                      placeholder="us-east-1"
                      value={awsRegion}
                      onChange={(e) => setAwsRegion(e.target.value)}
                    />
                  </div>
                </>
              )}

              {/* Host pattern */}
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">--host-pattern (optional)</label>
                <Input
                  type="text"
                  placeholder="*.example.com"
                  value={addHostPattern}
                  onChange={(e) => setAddHostPattern(e.target.value)}
                />
              </div>

              {addError && (
                <p className="text-xs text-destructive">[ERR] {addError}</p>
              )}

              <Button type="submit" disabled={addLoading}>
                {addLoading ? "> adding..." : "$ add --provider"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Provider list */}
      <div className="min-h-[200px]">
        {showLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2">
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchProviders}>
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : providers.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">{">"} no CDN providers configured</p>
              <p className="mt-1 text-xs text-muted-foreground">add a provider to enable CDN proxy detection</p>
              <Button className="mt-4" onClick={() => setShowAdd(true)}>
                + Add Provider
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2 animate-content-ready">
            <p className="text-xs text-muted-foreground px-2">
              {providers.length} provider{providers.length !== 1 ? "s" : ""} configured
            </p>
            {providers.map((provider) => {
              const busy = actionLoading[provider.id] ?? false;
              const validateBusy = actionLoading[`validate-${provider.id}`] ?? false;
              return (
                <Card key={provider.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 text-sm">
                        <span className="text-primary font-mono">[{provider.provider}]</span>
                        <span className="text-foreground font-medium">{provider.displayName}</span>
                        {provider.hostPattern && (
                          <span className="text-xs text-muted-foreground">
                            pattern: {provider.hostPattern}
                          </span>
                        )}
                        <span
                          className={cn(
                            "text-xs font-mono",
                            provider.isValid ? "text-primary" : "text-destructive",
                          )}
                        >
                          {provider.isValid ? "[OK]" : "[!!] invalid"}
                        </span>
                        {provider.lastValidatedAt && (
                          <span className="text-xs text-muted-foreground">
                            checked: {new Date(provider.lastValidatedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <button
                          disabled={validateBusy}
                          onClick={() => validateProvider(provider)}
                          className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                        >
                          {validateBusy ? "..." : "[validate]"}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => removeProvider(provider)}
                          className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        >
                          {busy ? "..." : "[delete]"}
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Proxy Check Tool */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs text-muted-foreground">$ infra cdn-providers check-proxy</p>
              <p className="text-sm font-semibold text-foreground">Proxy Detection Tool</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowProxyCheck(!showProxyCheck);
                if (!showProxyCheck && hosts.length === 0) loadHostsForProxyCheck();
              }}
            >
              {showProxyCheck ? "[-] collapse" : "[+] expand"}
            </Button>
          </div>

          {showProxyCheck && (
            <div className="space-y-4">
              {hostsLoading ? (
                <p className="text-xs text-muted-foreground animate-pulse">loading hosts...</p>
              ) : hosts.length === 0 ? (
                <p className="text-xs text-muted-foreground">{">"} no hosts available</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      onClick={selectAllHosts}
                      className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    >
                      {selectedHostIds.size === hosts.length ? "[deselect all]" : "[select all]"}
                    </button>
                    <span className="text-xs text-muted-foreground">
                      {selectedHostIds.size} selected
                    </span>
                  </div>

                  <div className="max-h-48 overflow-y-auto border border-border">
                    {hosts.map((host) => (
                      <label
                        key={host.id}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedHostIds.has(host.id)}
                          onChange={() => toggleHostSelection(host.id)}
                          className="accent-primary"
                        />
                        <span className="text-foreground font-mono">{host.hostname}</span>
                      </label>
                    ))}
                  </div>

                  <Button
                    size="sm"
                    disabled={proxyChecking || selectedHostIds.size === 0}
                    onClick={runProxyCheck}
                  >
                    {proxyChecking ? "> checking..." : `$ check-proxy (${selectedHostIds.size})`}
                  </Button>
                </>
              )}

              {/* Proxy check results */}
              {proxyResults.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-muted-foreground mb-2">results:</p>
                  <div className="overflow-x-auto">
                    <div className="min-w-[600px]">
                      <div className="grid grid-cols-[minmax(150px,2fr)_70px_100px_120px_80px] gap-x-3 border-b border-border px-2 py-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                        <span>Hostname</span>
                        <span>Proxied</span>
                        <span>Provider</span>
                        <span>Method</span>
                        <span>Config</span>
                      </div>
                      {proxyResults.map((result) => (
                        <div
                          key={result.hostId}
                          className="grid grid-cols-[minmax(150px,2fr)_70px_100px_120px_80px] gap-x-3 px-2 py-1.5 text-xs border border-transparent hover:border-border hover:bg-muted/30 transition-colors"
                        >
                          <span className="text-foreground font-mono truncate">
                            {result.hostname}
                          </span>
                          <span
                            className={cn(
                              "font-mono",
                              result.isProxied ? "text-primary" : "text-muted-foreground",
                            )}
                          >
                            {result.isProxied ? "[OK]" : "[--]"}
                          </span>
                          <span className="text-foreground">
                            {result.provider || "--"}
                          </span>
                          <span className="text-muted-foreground truncate">
                            {result.detectionMethod || "--"}
                          </span>
                          <span
                            className={cn(
                              "font-mono",
                              result.hasProviderConfig ? "text-primary" : "text-muted-foreground",
                            )}
                          >
                            {result.hasProviderConfig ? "[OK]" : "[--]"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
