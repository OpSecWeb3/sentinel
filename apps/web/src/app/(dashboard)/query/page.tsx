"use client";

import { Suspense, useState, useCallback, useEffect, lazy } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { apiPost } from "@/lib/api";
import { QueryBuilder } from "@/components/query-builder/query-builder";
import { QueryResults } from "@/components/query-builder/query-results";
import { defaultQueryState, serializeQuery, deserializeQuery } from "@/components/query-builder/utils";
import { cn } from "@/lib/utils";
import type { QueryState } from "@/components/query-builder/types";

// Lazy-load CodeMirror to avoid the bundle cost on initial page load
const QueryTextEditor = lazy(() =>
  import("@/components/query-builder/text-editor/query-text-editor").then((m) => ({ default: m.QueryTextEditor }))
);

type EditorMode = "visual" | "text";

export default function QueryPage() {
  return <Suspense><QueryPageInner /></Suspense>;
}

function QueryPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<EditorMode>("text");
  const [state, setState] = useState<QueryState>(() => {
    const q = searchParams.get("q");
    if (q) {
      const parsed = deserializeQuery(q);
      if (parsed) return parsed;
    }
    return defaultQueryState();
  });

  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [meta, setMeta] = useState<{ page: number; limit: number; total: number; totalPages: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);

  const syncUrl = useCallback((s: QueryState) => {
    const encoded = serializeQuery(s);
    router.replace(`/query?q=${encoded}`, { scroll: false });
  }, [router]);

  const handleChange = useCallback((s: QueryState) => {
    setState(s);
    syncUrl(s);
  }, [syncUrl]);

  const runQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    setHasRun(true);
    try {
      const res = await apiPost<{ data: Record<string, unknown>[]; meta: { page: number; limit: number; total: number; totalPages: number } }>("/api/query", state);
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed");
      setData([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [state]);

  const handlePageChange = useCallback((page: number) => {
    const next = { ...state, page };
    setState(next);
    syncUrl(next);
    setLoading(true);
    setError(null);
    apiPost<{ data: Record<string, unknown>[]; meta: { page: number; limit: number; total: number; totalPages: number } }>("/api/query", next)
      .then((res) => { setData(res.data); setMeta(res.meta); })
      .catch((err) => { setError(err instanceof Error ? err.message : "Query failed"); })
      .finally(() => setLoading(false));
  }, [state, syncUrl]);

  const handleClear = useCallback(() => {
    const fresh = defaultQueryState();
    setState(fresh);
    setData([]);
    setMeta(null);
    setHasRun(false);
    setError(null);
    router.replace("/query", { scroll: false });
  }, [router]);


  // Global Ctrl+Enter handled by both modes; only add for visual mode
  // (text editor handles its own Ctrl+Enter via CodeMirror keymap)
  useEffect(() => {
    if (mode !== "visual") return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        runQuery();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [runQuery, mode]);

  return (
    <div className="space-y-6">
      {/* Header with mode toggle */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ query {mode === "text" ? "--text" : "--builder"}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} {mode === "text" ? "text query editor · Tab to autocomplete" : "visual query builder"} · Ctrl+Enter to run
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs font-mono">
          {(["visual", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "px-3 py-1.5 border transition-colors",
                mode === m
                  ? "border-primary text-primary text-glow bg-primary/5"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50",
              )}
            >
              [{m}]
            </button>
          ))}
        </div>
      </div>

      {/* Editor: visual or text */}
      {mode === "visual" ? (
        <QueryBuilder state={state} onChange={handleChange} onRun={runQuery} onClear={handleClear} running={loading} />
      ) : (
        <div className="space-y-4">
          <Suspense fallback={
            <div className="border border-border bg-muted/10 p-4">
              <p className="text-xs text-muted-foreground animate-pulse">loading editor...</p>
            </div>
          }>
            <QueryTextEditor state={state} onChange={handleChange} onRun={runQuery} />
          </Suspense>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={runQuery}
              disabled={loading}
              className={cn(
                "px-4 py-2 text-xs font-mono border transition-colors",
                loading
                  ? "border-border text-muted-foreground cursor-not-allowed"
                  : "border-primary text-primary hover:bg-primary/10",
              )}
            >
              {loading ? "$ running..." : "$ run query"}
            </button>
            <button type="button" onClick={handleClear} className="text-xs text-muted-foreground hover:text-destructive transition-colors font-mono">[clear]</button>
          </div>
        </div>
      )}

      {/* Results */}
      {hasRun && (
        <div className="border-t border-border pt-4">
          <QueryResults collection={state.collection} data={data} meta={meta} loading={loading} error={error} onPageChange={handlePageChange} />
        </div>
      )}
    </div>
  );
}
