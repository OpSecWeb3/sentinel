"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface AbiInput {
  name: string;
  type: string;
}

interface AbiOutput {
  name: string;
  type: string;
}

interface AbiFunction {
  name: string;
  signature: string;
  stateMutability: string | null;
  inputs: AbiInput[];
  outputs: AbiOutput[];
}

interface ContractCallPanelProps {
  contractId: number;
  functions: AbiFunction[];
}

interface CallResult {
  result: unknown;
  type: string;
}

function formatDisplayValue(value: unknown, type: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    // Address — already checksummed from Viem
    if (type === "address") return value;
    // Bytes
    if (type.startsWith("bytes")) return value;
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => formatDisplayValue(v, "")).join(", ")}]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function parseArgValue(raw: string, type: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Bool
  if (type === "bool") {
    return trimmed === "true" || trimmed === "1";
  }
  // Integer types — pass as string, Viem handles BigInt conversion
  if (type.startsWith("uint") || type.startsWith("int")) {
    return trimmed;
  }
  // Arrays/tuples — parse as JSON
  if (type.endsWith("]") || type.startsWith("tuple")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function FunctionRow({ fn, contractId }: { fn: AbiFunction; contractId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [argValues, setArgValues] = useState<string[]>(() => fn.inputs.map(() => ""));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isCallable = fn.stateMutability === "view" || fn.stateMutability === "pure";

  async function handleCall() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const args = fn.inputs.map((inp, i) => parseArgValue(argValues[i] ?? "", inp.type));
      const res = await apiFetch<{ data: CallResult }>(
        `/modules/chain/contracts/${contractId}/call`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ functionName: fn.name, args }),
        },
      );
      setResult(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Call failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        onClick={() => isCallable && setExpanded(!expanded)}
        className={cn(
          "flex w-full items-center gap-3 text-xs py-1.5 transition-colors",
          isCallable ? "hover:text-primary cursor-pointer" : "cursor-default opacity-60",
        )}
      >
        <span className="font-mono text-muted-foreground/60 w-4">
          {isCallable ? (expanded ? "[-]" : "[+]") : ""}
        </span>
        <span className="text-foreground font-medium truncate">{fn.name}</span>
        <span
          className={cn(
            "font-mono shrink-0",
            fn.stateMutability === "view" || fn.stateMutability === "pure"
              ? "text-muted-foreground"
              : "text-warning",
          )}
        >
          [{fn.stateMutability ?? "?"}]
        </span>
        {fn.inputs.length > 0 && (
          <span className="text-muted-foreground/60 font-mono truncate">
            ({fn.inputs.map((i) => i.type).join(", ")})
          </span>
        )}
        {fn.outputs.length > 0 && (
          <span className="text-muted-foreground/60 font-mono truncate ml-auto">
            → {fn.outputs.map((o) => o.type).join(", ")}
          </span>
        )}
      </button>

      {expanded && isCallable && (
        <div className="pl-7 pb-3 space-y-2">
          {/* Input fields */}
          {fn.inputs.map((inp, i) => (
            <div key={i} className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground font-mono w-28 shrink-0 truncate">
                {inp.name || `arg${i}`}
                <span className="text-muted-foreground/50 ml-1">({inp.type})</span>
              </label>
              <input
                type="text"
                value={argValues[i] ?? ""}
                onChange={(e) => {
                  const next = [...argValues];
                  next[i] = e.target.value;
                  setArgValues(next);
                }}
                placeholder={inp.type}
                className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus:outline-none"
              />
            </div>
          ))}

          {/* Call button */}
          <button
            onClick={handleCall}
            disabled={loading}
            className="text-xs font-mono text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
          >
            {loading ? "[calling...]" : "[call]"}
          </button>

          {/* Result */}
          {result && (
            <div className="text-xs space-y-0.5">
              <span className="text-muted-foreground font-mono">result ({result.type}):</span>
              <pre className="bg-muted/30 border border-border rounded p-2 font-mono text-foreground whitespace-pre-wrap break-all">
                {formatDisplayValue(result.result, result.type)}
              </pre>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-xs text-destructive font-mono">[ERR] {error}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function ContractCallPanel({ contractId, functions }: ContractCallPanelProps) {
  const viewPureFns = functions.filter(
    (fn) => fn.stateMutability === "view" || fn.stateMutability === "pure",
  );
  const otherFns = functions.filter(
    (fn) => fn.stateMutability !== "view" && fn.stateMutability !== "pure",
  );

  if (functions.length === 0) {
    return <p className="text-xs text-muted-foreground">no functions in ABI</p>;
  }

  return (
    <div>
      {viewPureFns.map((fn) => (
        <FunctionRow key={`${fn.name}-${fn.signature}`} fn={fn} contractId={contractId} />
      ))}
      {otherFns.map((fn) => (
        <FunctionRow key={`${fn.name}-${fn.signature}`} fn={fn} contractId={contractId} />
      ))}
    </div>
  );
}
