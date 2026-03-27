"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types --------------------------------------------------------- */

interface Installation {
  id: string;
  installationId: string;
  targetLogin: string;
  targetType: string;
  status: string;
  createdAt: string;
}

interface Repository {
  id: string;
  fullName: string;
  visibility: string;
}

interface InstallUrlResponse {
  url: string;
}

/* -- page ---------------------------------------------------------- */

export default function GitHubOverviewPage() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [installRes, repoRes] = await Promise.all([
        apiGet<{ data: Installation[] }>("/modules/github/installations"),
        apiGet<{ data: Repository[] }>("/modules/github/repositories"),
      ]);

      setInstallations(installRes.data);
      setRepos(repoRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load GitHub data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const activeInstallations = installations.filter((i) => i.status === "active");
  const isConnected = activeInstallations.length > 0;

  async function handleInstallApp() {
    setInstalling(true);
    try {
      const res = await apiGet<InstallUrlResponse>("/modules/github/app/install");
      if (!/^https?:\/\//i.test(res.url)) {
        throw new Error("Invalid redirect URL received from server");
      }
      window.location.href = res.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get installation URL");
      setInstalling(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ github status
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} github module overview and connection status
          </p>
        </div>
        <Button onClick={handleInstallApp} disabled={installing}>
          {installing ? "..." : "+ Install GitHub App"}
        </Button>
      </div>

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "space-y-4" : "space-y-4 invisible"}>
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded border border-border bg-muted/20" />
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchData}>
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6 animate-content-ready">
            {/* Connection Status */}
            <Card>
              <CardHeader>
                <CardTitle>
                  <span className="text-muted-foreground">{">"}</span>{" "}
                  connection status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <span
                    className={
                      isConnected
                        ? "font-mono text-primary text-glow"
                        : "font-mono text-muted-foreground"
                    }
                  >
                    {isConnected ? "[connected]" : "[not connected]"}
                  </span>
                  {isConnected && (
                    <span className="text-xs text-muted-foreground">
                      {activeInstallations.length} active installation
                      {activeInstallations.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                {!isConnected && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    install the Sentinel GitHub App to start monitoring your repositories
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Quick Stats */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle>
                    <span className="text-muted-foreground">$</span> tracked repos
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <span className="text-2xl font-mono text-primary text-glow">
                    {repos.length}
                  </span>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    <span className="text-muted-foreground">$</span> installations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <span className="text-2xl font-mono text-primary text-glow">
                    {activeInstallations.length}
                  </span>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    <span className="text-muted-foreground">$</span> visibility
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-3 text-xs font-mono">
                    <span className="text-primary">
                      [public: {repos.filter((r) => r.visibility === "public").length}]
                    </span>
                    <span className="text-warning">
                      [private: {repos.filter((r) => r.visibility === "private").length}]
                    </span>
                    <span className="text-muted-foreground">
                      [internal: {repos.filter((r) => r.visibility === "internal").length}]
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Quick Links */}
            <Card>
              <CardHeader>
                <CardTitle>
                  <span className="text-muted-foreground">{">"}</span>{" "}
                  quick navigation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-3 text-sm">
                  <Link
                    href="/github/installations"
                    className="text-muted-foreground hover:text-primary transition-colors"
                  >
                    [installations]
                  </Link>
                  <Link
                    href="/github/repositories"
                    className="text-muted-foreground hover:text-primary transition-colors"
                  >
                    [repositories]
                  </Link>
                  <Link
                    href="/github/templates"
                    className="text-muted-foreground hover:text-primary transition-colors"
                  >
                    [templates]
                  </Link>
                  <Link
                    href="/github/events"
                    className="text-muted-foreground hover:text-primary transition-colors"
                  >
                    [events]
                  </Link>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
