"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { FilterBar } from "@/components/ui/filter-bar";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/* -- types --------------------------------------------------------- */

interface Repository {
  id: string;
  installationId: string;
  githubId: string;
  fullName: string;
  name: string;
  owner: string;
  visibility: string;
  defaultBranch: string;
  archived: boolean;
  language: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* -- helpers ------------------------------------------------------- */

const visibilityBadge: Record<string, { label: string; variant: "default" | "warning" | "secondary" }> = {
  public: { label: "public", variant: "default" },
  private: { label: "private", variant: "warning" },
  internal: { label: "internal", variant: "secondary" },
};

function formatDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

/* -- page ---------------------------------------------------------- */

export default function GitHubRepositoriesPage() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [visibilityFilter, setVisibilityFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchRepos = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ data: Repository[] }>("/modules/github/repositories");
      setRepos(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load repositories");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  // Client-side filtering
  const filteredRepos = repos.filter((repo) => {
    if (visibilityFilter !== "all" && repo.visibility !== visibilityFilter) return false;
    if (debouncedSearch && !repo.fullName.toLowerCase().includes(debouncedSearch.toLowerCase())) return false;
    return true;
  });

  const hasActiveFilters = visibilityFilter !== "all" || debouncedSearch !== "";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ github repos ls
            {hasActiveFilters && (
              <span className="text-muted-foreground"> --filter</span>
            )}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} tracked github repositories
          </p>
        </div>
        <Link
          href="/github"
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          [back]
        </Link>
      </div>

      {/* Search */}
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="search repositories by name..."
        inputRef={searchInputRef}
      />

      {/* Filters */}
      <FilterBar
        filters={[
          {
            key: "visibility",
            label: "visibility",
            value: visibilityFilter === "all" ? null : visibilityFilter,
            options: [
              { value: "public", label: "public" },
              { value: "private", label: "private" },
              { value: "internal", label: "internal" },
            ],
            onChange: (v) => setVisibilityFilter(v ?? "all"),
          },
        ]}
        onClearAll={() => {
          setVisibilityFilter("all");
          setSearchQuery("");
        }}
        hasActiveFilters={hasActiveFilters}
      />

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading ? (
          <div className="space-y-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-48 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchRepos}>
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : filteredRepos.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no repositories found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasActiveFilters
                  ? "try adjusting or clearing your filters"
                  : repos.length === 0
                    ? "sync your installations to populate repositories"
                    : "no repositories match your criteria"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[700px]">
              <Table>
                <colgroup>
                  <col />
                  <col className="w-20" />
                  <col className="w-[70px]" />
                  <col className="w-[100px]" />
                  <col className="w-[100px]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead scope="col">Repository</TableHead>
                    <TableHead scope="col">Visibility</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Branch</TableHead>
                    <TableHead scope="col" className="text-right">
                      Last Synced
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="animate-stagger">
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableCell colSpan={5} className="border-0 py-2 text-xs text-muted-foreground">
                      {filteredRepos.length} repositor{filteredRepos.length !== 1 ? "ies" : "y"}
                      {filteredRepos.length !== repos.length && ` of ${repos.length} total`}
                    </TableCell>
                  </TableRow>
                  {filteredRepos.map((repo) => {
                    const vis = visibilityBadge[repo.visibility] ?? {
                      label: repo.visibility,
                      variant: "secondary" as const,
                    };

                    return (
                      <TableRow
                        key={repo.id}
                        className="group border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30"
                      >
                        <TableCell className="max-w-0 font-mono font-medium text-foreground">
                          <span className="block truncate transition-colors group-hover:text-primary">
                            {repo.fullName}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={vis.variant}>[{vis.label}]</Badge>
                        </TableCell>
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            repo.archived ? "text-muted-foreground" : "text-primary",
                          )}
                        >
                          {repo.archived ? "[archived]" : "[active]"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {repo.defaultBranch}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {formatDate(repo.syncedAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
