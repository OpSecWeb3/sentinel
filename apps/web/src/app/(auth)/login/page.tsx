"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  // Prevent open-redirect: only allow relative paths, reject protocol-relative URLs
  const nextUrl =
    rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//")
      ? rawNext
      : null;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await apiFetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      router.push(nextUrl ?? "/dashboard");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Invalid username or password"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <p className="text-sm text-primary text-glow">
          $ auth login
          <span className="ml-1 animate-pulse">_</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} enter your credentials
        </p>
      </div>

      {error && (
        <p className="text-xs text-destructive">[ERR] {error}</p>
      )}

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            --username
          </label>
          <Input
            type="text"
            placeholder="username or email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            autoComplete="username"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            --password
          </label>
          <Input
            type="password"
            placeholder="********"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "> authenticating..." : "$ login"}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        {">"} no account?{" "}
        <Link href="/register" className="text-primary hover:underline">
          register
        </Link>
      </p>
    </form>
  );
}
