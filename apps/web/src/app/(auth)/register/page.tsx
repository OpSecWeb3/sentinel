"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Mode = "first-user" | "invite";

export default function RegisterPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("first-user");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [inviteSecret, setInviteSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [inviteSecretResult, setInviteSecretResult] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const body: Record<string, string> = { username, email, password };
      if (mode === "first-user") {
        body.orgName = orgName;
      } else {
        body.inviteSecret = inviteSecret;
      }

      const res = await apiFetch<{
        inviteSecret?: string;
        user: { id: string; username: string };
        org: { id: string; name: string; slug: string };
      }>("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      // If first-user registration, show the invite secret before redirect
      if (res.inviteSecret) {
        setInviteSecretResult(res.inviteSecret);
        return;
      }

      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  // After first-user registration, show invite secret
  if (inviteSecretResult) {
    return (
      <div className="space-y-5">
        <div>
          <p className="text-sm text-primary text-glow">
            $ org init [OK]
            <span className="ml-1 animate-pulse">_</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {">"} organisation created. save your invite secret now — it cannot
            be shown again.
          </p>
        </div>

        <div className="border border-border bg-background p-3">
          <p className="mb-1 text-xs text-muted-foreground">INVITE_SECRET</p>
          <p className="break-all font-mono text-sm text-primary text-glow">
            {inviteSecretResult}
          </p>
        </div>

        <p className="text-xs text-muted-foreground">
          {">"} share this secret with team members so they can join your org.
        </p>

        <Button
          className="w-full"
          onClick={() => router.push("/dashboard")}
        >
          $ continue to dashboard
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <p className="text-sm text-primary text-glow">
          $ auth register
          <span className="ml-1 animate-pulse">_</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} create a new account
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">--mode</span>
        <button
          type="button"
          onClick={() => setMode("first-user")}
          className={
            mode === "first-user"
              ? "text-foreground"
              : "text-muted-foreground/60 hover:text-foreground transition-colors"
          }
        >
          {mode === "first-user" ? "[new-org]" : "new-org"}
        </button>
        <button
          type="button"
          onClick={() => setMode("invite")}
          className={
            mode === "invite"
              ? "text-foreground"
              : "text-muted-foreground/60 hover:text-foreground transition-colors"
          }
        >
          {mode === "invite" ? "[join-org]" : "join-org"}
        </button>
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
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            autoComplete="username"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            --email
          </label>
          <Input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            --password
          </label>
          <Input
            type="password"
            placeholder="min 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </div>

        {mode === "first-user" ? (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              --org-name
            </label>
            <Input
              type="text"
              placeholder="My Organisation"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {">"} creates a new organisation (first user becomes admin)
            </p>
          </div>
        ) : (
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
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {">"} join an existing organisation
            </p>
          </div>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "> creating account..." : "$ register"}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        {">"} already have an account?{" "}
        <Link href="/login" className="text-primary hover:underline">
          login
        </Link>
      </p>
    </form>
  );
}
