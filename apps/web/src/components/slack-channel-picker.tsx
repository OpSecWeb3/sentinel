"use client";

import { useState, useRef, useEffect } from "react";
import { Lock, Loader2, Search } from "lucide-react";

interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface SlackChannelPickerProps {
  value: string;
  valueName?: string;
  onValueChange: (id: string, name: string) => void;
  fetchChannels: (query: string) => Promise<SlackChannel[]>;
}

export function SlackChannelPicker({
  value,
  valueName,
  onValueChange,
  fetchChannels,
}: SlackChannelPickerProps) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SlackChannel[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function handleFind() {
    const q = search.trim();
    if (q.length < 2) return;
    setSearching(true);
    setSearched(false);
    try {
      const channels = await fetchChannels(q);
      setResults(channels);
      setSearched(true);
      setOpen(true);
    } catch {
      setResults([]);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleFind();
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-2">
      {value && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">#</span>
          <span className="text-foreground">{valueName || value}</span>
          <button
            type="button"
            onClick={() => onValueChange("", "")}
            className="ml-1 text-xs text-muted-foreground hover:text-destructive"
          >
            [clear]
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          placeholder="Type channel name to search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          onClick={handleFind}
          disabled={searching || search.trim().length < 2}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {searching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Find
        </button>
      </div>

      {open && searched && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
          <div className="max-h-60 overflow-y-auto">
            <button
              type="button"
              onClick={() => { onValueChange("", ""); setOpen(false); setSearch(""); }}
              className={`flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${!value ? "bg-accent" : ""}`}
            >
              <span className="text-muted-foreground">None (no Slack notification)</span>
            </button>

            {results.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No channels found.</p>
            ) : (
              results.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => { onValueChange(ch.id, ch.name); setOpen(false); setSearch(""); }}
                  className={`flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${value === ch.id ? "bg-accent" : ""}`}
                >
                  {ch.isPrivate ? (
                    <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                  ) : (
                    <span className="text-muted-foreground shrink-0">#</span>
                  )}
                  <span className="truncate">{ch.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
