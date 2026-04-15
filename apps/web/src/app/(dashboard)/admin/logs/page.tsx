"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Select } from "@/components/ui/select";
import { apiGet, ApiError } from "@/lib/api";

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

interface LogEntry {
  timestamp: string;
  stream: "stdout" | "stderr";
  message: string;
}

interface ContainersResponse {
  containers?: ContainerInfo[];
  error?: string;
}

interface LogsResponse {
  container?: { id: string; name: string };
  logs?: LogEntry[];
  error?: string;
}

const TAIL_OPTIONS = [100, 200, 500, 1000, 2000, 5000] as const;
const STREAM_OPTIONS = ["all", "stdout", "stderr"] as const;
const REFRESH_INTERVAL = 5000;

function LogLine({ entry }: { entry: LogEntry }) {
  const ts = entry.timestamp
    ? entry.timestamp.replace(/T/, " ").replace(/\.\d+Z$/, "Z")
    : "";

  const parts = entry.message.match(/^(\[[^\]]+\])\s*(.*)/);

  return (
    <div className="flex gap-2 leading-5 hover:bg-gray-900/50">
      {ts && <span className="shrink-0 text-gray-600 select-none">{ts}</span>}
      {entry.stream === "stderr" ? (
        <span className="text-red-400">{entry.message}</span>
      ) : parts ? (
        <>
          <span className="text-yellow-400">{parts[1]}</span>
          <span className="text-gray-300">{parts[2]}</span>
        </>
      ) : (
        <span className="text-gray-300">{entry.message}</span>
      )}
    </div>
  );
}

export default function AdminLogsPage() {
  const [error, setError] = useState<string | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [service, setService] = useState("");
  const [tail, setTail] = useState(200);
  const [search, setSearch] = useState("");
  const [since, setSince] = useState("");
  const [stream, setStream] = useState<"all" | "stdout" | "stderr">("all");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [containerName, setContainerName] = useState("");

  const logEndRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchContainers = useCallback(async () => {
    try {
      const res = await apiGet<ContainersResponse>("/api/admin/logs/containers");
      if (res.error) {
        setError(res.error);
        return;
      }
      const list = res.containers ?? [];
      setContainers(list);
      if (list.length && !service) setService(list[0].name);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("admin role required");
      } else {
        setError(err instanceof Error ? err.message : "failed to fetch containers");
      }
    }
  }, [service]);

  useEffect(() => {
    fetchContainers();
  }, [fetchContainers]);

  const fetchLogs = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        service,
        tail: String(tail),
        stream,
      });
      if (search) params.set("search", search);
      if (since) {
        // datetime-local emits "YYYY-MM-DDTHH:mm" in browser local time.
        // new Date() interprets that as local time; toISOString() converts to UTC.
        const iso = new Date(since).toISOString();
        params.set("since", iso);
      }

      const res = await apiGet<LogsResponse>(`/api/admin/logs?${params}`);
      if (res.error) {
        setError(res.error);
        setLogs([]);
        return;
      }
      setLogs(res.logs ?? []);
      setContainerName(res.container?.name ?? service);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [service, tail, search, stream, since]);

  useEffect(() => {
    if (service) fetchLogs();
  }, [fetchLogs, service]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchLogs, REFRESH_INTERVAL);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchLogs]);

  return (
    <div className="p-6 flex flex-col gap-6">
      <div>
        <h1 className="text-lg">
          $ admin logs
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} container log viewer
        </p>
      </div>

      <div className="flex flex-wrap gap-4 items-end">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          container:
          <Select
            value={service}
            onValueChange={setService}
            placeholder="no containers"
            options={containers.map((c) => ({ value: c.name, label: c.name }))}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          tail:
          <Select
            value={String(tail)}
            onValueChange={(v) => setTail(Number(v))}
            options={TAIL_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          stream:
          <Select
            value={stream}
            onValueChange={(v) => setStream(v as "all" | "stdout" | "stderr")}
            options={STREAM_OPTIONS.map((s) => ({ value: s, label: s }))}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          search:
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") fetchLogs();
            }}
            placeholder="filter text..."
            className="bg-gray-900 border border-gray-700 text-green-400 text-sm font-mono rounded px-2 py-1 w-48"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          since:
          <div className="flex gap-1">
            <input
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="bg-gray-900 border border-gray-700 text-green-400 text-sm font-mono rounded px-2 py-1"
            />
            {since && (
              <button
                onClick={() => setSince("")}
                title="clear since filter"
                className="text-xs text-muted-foreground hover:text-primary border border-gray-700 rounded px-2"
              >
                x
              </button>
            )}
          </div>
        </label>

        <button
          onClick={fetchLogs}
          className="text-xs text-muted-foreground hover:text-primary border border-gray-700 rounded px-2 py-1 transition-colors h-[30px]"
        >
          $ refresh
        </button>

        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`text-xs border rounded px-2 py-1 transition-colors h-[30px] ${
            autoRefresh
              ? "text-primary border-primary"
              : "text-muted-foreground border-gray-700 hover:text-primary"
          }`}
        >
          {autoRefresh ? "● auto" : "○ auto"}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">[ERR] {error}</p>}

      <div className="flex-1 border border-gray-700 rounded overflow-hidden flex flex-col">
        <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-700 bg-gray-900/50 text-xs text-muted-foreground">
          <span>
            {containerName ? `container: ${containerName}` : "select a container"}
          </span>
          <span>{logs.length} lines</span>
          {loading && <span className="animate-pulse text-primary">fetching...</span>}
          {autoRefresh && (
            <span className="text-primary/60">
              refreshing every {REFRESH_INTERVAL / 1000}s
            </span>
          )}
        </div>

        <div className="flex-1 overflow-auto p-4 text-xs max-h-[calc(100vh-300px)] min-h-[400px]">
          {logs.length === 0 && !loading ? (
            <p className="text-muted-foreground">
              {service
                ? "no logs found for current filters"
                : "select a container to view logs"}
            </p>
          ) : (
            logs.map((entry, i) => <LogLine key={i} entry={entry} />)
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
