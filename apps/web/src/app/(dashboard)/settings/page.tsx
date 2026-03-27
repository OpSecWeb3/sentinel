"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/use-toast";

/* ── types ───────────────────────────────────────────────────── */

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

interface Member {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt: string;
}

interface NotifyKeyStatus {
  exists: boolean;
  prefix?: string;
  lastUsedAt?: string | null;
}

/* ── page ────────────────────────────────────────────────────── */

export default function SettingsPage() {
  const { toast } = useToast();

  // Section toggle
  const [section, setSection] = useState<
    "api-keys" | "invite" | "members" | "notify-key"
  >("api-keys");

  // API Keys
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null);
  const [createKeyLoading, setCreateKeyLoading] = useState(false);

  // Invite secret
  const [inviteSecret, setInviteSecret] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  // Members
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);

  // Notify key
  const [notifyKeyStatus, setNotifyKeyStatus] =
    useState<NotifyKeyStatus | null>(null);
  const [notifyKeyLoading, setNotifyKeyLoading] = useState(false);
  const [notifyKeyResult, setNotifyKeyResult] = useState<string | null>(null);

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

  /* ── fetch API keys ────────────────────────────────────────── */

  const fetchApiKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const res = await apiFetch<ApiKey[]>("/auth/api-keys", {
        credentials: "include",
      });
      setApiKeys(res);
    } catch {
      toast("Failed to load API keys.");
    } finally {
      setKeysLoading(false);
    }
  }, [toast]);

  /* ── fetch members ─────────────────────────────────────────── */

  const fetchMembers = useCallback(async () => {
    setMembersLoading(true);
    try {
      const res = await apiFetch<Member[]>("/auth/users", {
        credentials: "include",
      });
      setMembers(res);
    } catch {
      // may fail for non-admins
    } finally {
      setMembersLoading(false);
    }
  }, []);

  /* ── fetch notify key status ───────────────────────────────── */

  const fetchNotifyKeyStatus = useCallback(async () => {
    try {
      const res = await apiFetch<NotifyKeyStatus>(
        "/auth/org/notify-key/status",
        { credentials: "include" },
      );
      setNotifyKeyStatus(res);
    } catch {
      // may fail for non-admins
    }
  }, []);

  useEffect(() => {
    fetchApiKeys();
    fetchMembers();
    fetchNotifyKeyStatus();
  }, [fetchApiKeys, fetchMembers, fetchNotifyKeyStatus]);

  /* ── create API key ────────────────────────────────────────── */

  async function createApiKey(e: React.FormEvent) {
    e.preventDefault();
    setCreateKeyLoading(true);
    setNewKeyResult(null);
    try {
      const res = await apiFetch<{ key: string; id: string; name: string }>(
        "/auth/api-keys",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newKeyName }),
        },
      );
      setNewKeyResult(res.key);
      setNewKeyName("");
      fetchApiKeys();
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to create API key",
      );
    } finally {
      setCreateKeyLoading(false);
    }
  }

  /* ── revoke API key ────────────────────────────────────────── */

  async function revokeApiKey(key: ApiKey) {
    const confirmed = await confirm(
      "Revoke API Key",
      `Revoke "${key.name}" (${key.keyPrefix}...)? This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/auth/api-keys/${key.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      fetchApiKeys();
      toast(`API key "${key.name}" revoked.`);
    } catch {
      toast("Failed to revoke API key.");
    }
  }

  /* ── invite secret ─────────────────────────────────────────── */

  async function fetchInviteSecret() {
    setInviteLoading(true);
    try {
      const res = await apiFetch<{ inviteSecret: string }>(
        "/auth/org/invite-secret",
        { credentials: "include" },
      );
      setInviteSecret(res.inviteSecret);
    } catch (err) {
      // 404 means no secret has been generated yet — that's a normal state
      if (err instanceof ApiError && err.status === 404) {
        setInviteSecret(null);
      } else {
        toast("Failed to load invite secret.");
      }
    } finally {
      setInviteLoading(false);
    }
  }

  async function regenerateInviteSecret() {
    const confirmed = await confirm(
      "Regenerate Invite Secret",
      "This will invalidate the current invite secret. Existing invites will stop working.",
    );
    if (!confirmed) return;
    setInviteLoading(true);
    try {
      const res = await apiFetch<{ inviteSecret: string }>(
        "/auth/org/invite-secret/regenerate",
        { method: "POST", credentials: "include" },
      );
      setInviteSecret(res.inviteSecret);
      toast("Invite secret regenerated.");
    } catch {
      toast("Failed to regenerate invite secret.");
    } finally {
      setInviteLoading(false);
    }
  }

  /* ── notify key ────────────────────────────────────────────── */

  async function generateNotifyKey() {
    setNotifyKeyLoading(true);
    setNotifyKeyResult(null);
    try {
      const endpoint = notifyKeyStatus?.exists
        ? "/auth/org/notify-key/rotate"
        : "/auth/org/notify-key/generate";
      const res = await apiFetch<{ key: string; prefix: string }>(endpoint, {
        method: "POST",
        credentials: "include",
      });
      setNotifyKeyResult(res.key);
      fetchNotifyKeyStatus();
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to generate notify key",
      );
    } finally {
      setNotifyKeyLoading(false);
    }
  }

  async function revokeNotifyKey() {
    const confirmed = await confirm(
      "Revoke Notify Key",
      "This will immediately disable all webhook-triggered event ingestion. Are you sure?",
    );
    if (!confirmed) return;
    try {
      await apiFetch("/auth/org/notify-key", {
        method: "DELETE",
        credentials: "include",
      });
      setNotifyKeyStatus({ exists: false });
      setNotifyKeyResult(null);
      toast("Notify key revoked.");
    } catch {
      toast("Failed to revoke notify key.");
    }
  }

  /* ── change member role ────────────────────────────────────── */

  async function changeRole(member: Member, newRole: string) {
    try {
      await apiFetch(`/auth/users/${member.id}/role`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      setMembers((prev) =>
        prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m)),
      );
      toast(`${member.username} role updated to ${newRole}.`);
    } catch {
      toast("Failed to update role.");
    }
  }

  /* ── render ────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        description={confirmDesc}
        onClose={handleConfirmClose}
      />

      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ settings
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} organisation settings and key management
        </p>
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">--section</span>
        {(
          [
            { key: "api-keys", label: "api-keys" },
            { key: "invite", label: "invite" },
            { key: "members", label: "members" },
            { key: "notify-key", label: "notify-key" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={cn(
              "transition-colors",
              section === key
                ? "text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            {section === key ? `[${label}]` : label}
          </button>
        ))}
      </div>

      {/* ── API Keys Section ─────────────────────────────────── */}
      {section === "api-keys" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            $ auth api-keys ls
          </p>

          {/* Create form */}
          <Card>
            <CardContent className="p-4">
              <p className="mb-3 text-xs text-muted-foreground">
                $ auth api-keys create
              </p>
              <form
                onSubmit={createApiKey}
                className="flex items-end gap-3"
              >
                <div className="flex-1">
                  <label className="mb-1 block text-xs text-muted-foreground">
                    --name
                  </label>
                  <Input
                    placeholder="key name (e.g. ci-pipeline)"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" disabled={createKeyLoading}>
                  {createKeyLoading ? "..." : "$ create"}
                </Button>
              </form>

              {newKeyResult && (
                <div className="mt-3 border border-border bg-background p-3">
                  <p className="mb-1 text-xs text-warning">
                    [!] save this key now. it cannot be shown again.
                  </p>
                  <p className="break-all font-mono text-sm text-primary text-glow">
                    {newKeyResult}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Key list */}
          {keysLoading ? (
            <div className="animate-pulse space-y-2">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="h-12 rounded bg-muted-foreground/10"
                />
              ))}
            </div>
          ) : apiKeys.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {">"} no API keys. create one above.
            </p>
          ) : (
            <div className="space-y-2">
              {apiKeys.map((key) => (
                <Card key={key.id}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <span className="font-medium text-foreground">
                        {key.name}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {key.keyPrefix}...
                      </span>
                      {key.revoked && (
                        <span className="ml-2 text-xs text-destructive">
                          [revoked]
                        </span>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">
                        scopes: [{key.scopes.join(", ")}] | created{" "}
                        {new Date(key.createdAt).toLocaleDateString()}
                        {key.lastUsedAt &&
                          ` | last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                        {key.expiresAt &&
                          ` | expires ${new Date(key.expiresAt).toLocaleDateString()}`}
                      </div>
                    </div>
                    {!key.revoked && (
                      <button
                        onClick={() => revokeApiKey(key)}
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                      >
                        [revoke]
                      </button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Invite Section ───────────────────────────────────── */}
      {section === "invite" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            $ org invite-secret
          </p>

          <Card>
            <CardContent className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                {">"} share this secret with team members so they can join your
                org during registration.
              </p>

              {inviteSecret ? (
                <div className="border border-border bg-background p-3">
                  <p className="break-all font-mono text-sm text-primary text-glow">
                    {inviteSecret}
                  </p>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchInviteSecret}
                  disabled={inviteLoading}
                >
                  {inviteLoading ? "..." : "$ reveal"}
                </Button>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={regenerateInviteSecret}
                  disabled={inviteLoading}
                >
                  $ regenerate
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Members Section ──────────────────────────────────── */}
      {section === "members" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">$ org members ls</p>

          {membersLoading ? (
            <div className="animate-pulse space-y-2">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="h-12 rounded bg-muted-foreground/10"
                />
              ))}
            </div>
          ) : members.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {">"} no members found (you may not have admin access).
            </p>
          ) : (
            <div className="space-y-2">
              {members.map((member) => (
                <Card key={member.id}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div>
                      <span className="font-medium text-foreground">
                        {member.username}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {member.email}
                      </span>
                      <div className="mt-1 text-xs">
                        <span
                          className={cn(
                            member.role === "admin"
                              ? "text-primary"
                              : "text-muted-foreground",
                          )}
                        >
                          [{member.role}]
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          joined{" "}
                          {new Date(member.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {["admin", "editor", "viewer"].map((role) => (
                        <button
                          key={role}
                          onClick={() => changeRole(member, role)}
                          className={cn(
                            "transition-colors",
                            member.role === role
                              ? "text-primary"
                              : "text-muted-foreground/60 hover:text-foreground",
                          )}
                        >
                          {member.role === role ? `[${role}]` : role}
                        </button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Notify Key Section ───────────────────────────────── */}
      {section === "notify-key" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            $ org notify-key status
          </p>

          <Card>
            <CardContent className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                {">"} the notify key authenticates incoming webhooks from
                external sources (e.g. GitHub). Modules use it for event
                ingestion.
              </p>

              {notifyKeyStatus ? (
                <div className="text-xs">
                  <span className="text-muted-foreground">status: </span>
                  <span
                    className={
                      notifyKeyStatus.exists
                        ? "text-primary"
                        : "text-muted-foreground"
                    }
                  >
                    {notifyKeyStatus.exists ? "[configured]" : "[not set]"}
                  </span>
                  {notifyKeyStatus.prefix && (
                    <span className="ml-3 text-muted-foreground">
                      prefix: {notifyKeyStatus.prefix}...
                    </span>
                  )}
                  {notifyKeyStatus.lastUsedAt && (
                    <span className="ml-3 text-muted-foreground">
                      last used:{" "}
                      {new Date(
                        notifyKeyStatus.lastUsedAt,
                      ).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">loading...</p>
              )}

              {notifyKeyResult && (
                <div className="border border-border bg-background p-3">
                  <p className="mb-1 text-xs text-warning">
                    [!] save this key now. it cannot be shown again.
                  </p>
                  <p className="break-all font-mono text-sm text-primary text-glow">
                    {notifyKeyResult}
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={generateNotifyKey}
                  disabled={notifyKeyLoading}
                >
                  {notifyKeyLoading
                    ? "..."
                    : notifyKeyStatus?.exists
                      ? "$ rotate"
                      : "$ generate"}
                </Button>
                {notifyKeyStatus?.exists && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={revokeNotifyKey}
                    className="text-destructive"
                  >
                    $ revoke
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
