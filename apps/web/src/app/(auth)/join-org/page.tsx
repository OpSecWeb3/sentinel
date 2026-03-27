"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function JoinOrgPage() {
  const router = useRouter();
  const [inviteSecret, setInviteSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await apiFetch("/auth/org/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ inviteSecret }),
      });

      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join organisation");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <p className="text-sm text-primary text-glow">
          $ org join
          <span className="ml-1 animate-pulse">_</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} your account is not part of an organisation. enter an invite
          secret to join one.
        </p>
      </div>

      {error && (
        <p className="text-xs text-destructive">[ERR] {error}</p>
      )}

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          --invite-secret
        </label>
        <Input
          type="text"
          placeholder="paste invite secret"
          value={inviteSecret}
          onChange={(e) => setInviteSecret(e.target.value)}
          required
          autoFocus
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} ask your organisation admin for the invite secret
        </p>
      </div>

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "> joining..." : "$ join organisation"}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        {">"} want to create a new organisation instead?{" "}
        <Link href="/register" className="text-primary hover:underline">
          register
        </Link>
      </p>
    </form>
  );
}
