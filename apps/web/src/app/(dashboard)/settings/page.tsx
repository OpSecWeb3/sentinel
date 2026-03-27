"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

interface CdnProvider {
  id: string;
  provider: string;
  displayName: string;
  hostPattern: string;
  isValid: boolean;
  lastValidatedAt: string | null;
  createdAt: string;
}

interface ProxyCheckResult {
  hostId: string;
  hostname: string;
  isProxied: boolean;
  provider: string;
  detectionMethod: string;
  hasProviderConfig: boolean;
}

interface Channel {
  id: string;
  orgId: string;
  name: string;
  type: "email" | "webhook";
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

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

interface SlackStatus {
  connected: boolean;
  teamId?: string;
  teamName?: string;
  installedAt?: string;
}

interface WebhookConfig {
  webhookUrl: string;
  npmWebhookUrl: string;
  hasSecret: boolean;
  secretPrefix: string | null;
}

interface RpcNetwork {
  id: number;
  name: string;
  chainId: number;
}

interface RpcConfig {
  id: number;
  networkId: number;
  networkName: string;
  networkSlug: string;
  chainId: number;
  customUrl: string;
  status: "active" | "inactive" | "error";
  callCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  lastCheckedAt: string | null;
  isActive: boolean;
  createdAt: string;
}

/* ── page ────────────────────────────────────────────────────── */

export default function SettingsPage() {
  const { toast, toasts, dismiss } = useToast();

  // Section toggle
  const [section, setSection] = useState<
    "api-keys" | "invite" | "members" | "notify-key" | "slack" | "webhook" | "channels" | "rpc" | "cdn-providers"
  >("members");

  // RPC configs
  const [rpcConfigs, setRpcConfigs] = useState<RpcConfig[]>([]);
  const [rpcNetworks, setRpcNetworks] = useState<RpcNetwork[]>([]);
  const [rpcLoading, setRpcLoading] = useState(false);
  const showRpcLoading = useDelayedLoading(rpcLoading);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [showAddRpcForm, setShowAddRpcForm] = useState(false);
  const [addRpcNetworkId, setAddRpcNetworkId] = useState("");
  const [addRpcUrl, setAddRpcUrl] = useState("");
  const [addingRpc, setAddingRpc] = useState(false);

  // Channels
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const showChannelsLoading = useDelayedLoading(channelsLoading);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [createChannelType, setCreateChannelType] = useState<"email" | "webhook">("webhook");
  const [createChannelName, setCreateChannelName] = useState("");
  const [createChannelUrl, setCreateChannelUrl] = useState("");
  const [createChannelRecipients, setCreateChannelRecipients] = useState("");
  const [createChannelLoading, setCreateChannelLoading] = useState(false);
  const [channelActionLoading, setChannelActionLoading] = useState<Record<string, boolean>>({});

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

  // CDN providers
  const [cdnProviders, setCdnProviders] = useState<CdnProvider[]>([]);
  const [cdnLoading, setCdnLoading] = useState(true);
  const showCdnLoading = useDelayedLoading(cdnLoading);
  const [cdnError, setCdnError] = useState<string | null>(null);
  const [cdnActionLoading, setCdnActionLoading] = useState<Record<string, boolean>>({});
  const [showAddCdn, setShowAddCdn] = useState(false);
  const [addCdnProvider, setAddCdnProvider] = useState<"cloudflare" | "cloudfront">("cloudflare");
  const [addCdnDisplayName, setAddCdnDisplayName] = useState("");
  const [addCdnHostPattern, setAddCdnHostPattern] = useState("");
  const [addCdnLoading, setAddCdnLoading] = useState(false);
  const [addCdnError, setAddCdnError] = useState<string | null>(null);
  const [cfApiToken, setCfApiToken] = useState("");
  const [cfAccountId, setCfAccountId] = useState("");
  const [awsAccessKey, setAwsAccessKey] = useState("");
  const [awsSecretKey, setAwsSecretKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [showProxyCheck, setShowProxyCheck] = useState(false);
  const [cdnHosts, setCdnHosts] = useState<{ id: string; hostname: string }[]>([]);
  const [cdnHostsLoading, setCdnHostsLoading] = useState(false);
  const [selectedCdnHostIds, setSelectedCdnHostIds] = useState<Set<string>>(new Set());
  const [proxyResults, setProxyResults] = useState<ProxyCheckResult[]>([]);
  const [proxyChecking, setProxyChecking] = useState(false);

  // Slack
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [slackLoading, setSlackLoading] = useState(false);

  // Webhook config
  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig | null>(
    null,
  );
  const [webhookConfigLoading, setWebhookConfigLoading] = useState(false);
  const [rotateLoading, setRotateLoading] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

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

  /* ── fetch Slack status ─────────────────────────────────────── */

  const fetchSlackStatus = useCallback(async () => {
    setSlackLoading(true);
    try {
      const res = await apiFetch<SlackStatus>("/integrations/slack", {
        credentials: "include",
      });
      setSlackStatus(res);
    } catch {
      setSlackStatus({ connected: false });
    } finally {
      setSlackLoading(false);
    }
  }, []);

  /* ── fetch webhook config ───────────────────────────────────── */

  const fetchWebhookConfig = useCallback(async () => {
    setWebhookConfigLoading(true);
    try {
      const res = await apiFetch<WebhookConfig>(
        "/modules/registry/webhook-config",
        { credentials: "include" },
      );
      setWebhookConfig(res);
    } catch {
      toast("Failed to load webhook configuration.");
    } finally {
      setWebhookConfigLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchApiKeys();
    fetchMembers();
    fetchNotifyKeyStatus();
  }, [fetchApiKeys, fetchMembers, fetchNotifyKeyStatus]);

  const fetchChannels = useCallback(async () => {
    setChannelsLoading(true);
    setChannelsError(null);
    try {
      const res = await apiFetch<{ data: Channel[] }>("/api/channels", { credentials: "include" });
      setChannels(res.data);
    } catch (err) {
      setChannelsError(err instanceof Error ? err.message : "Failed to load channels");
    } finally {
      setChannelsLoading(false);
    }
  }, []);

  /* ── fetch RPC configs ──────────────────────────────────────── */

  const fetchRpcConfigs = useCallback(async () => {
    setRpcLoading(true);
    setRpcError(null);
    try {
      const res = await apiFetch<{ data: RpcConfig[]; meta: { total: number } }>(
        "/modules/chain/rpc-configs",
        { credentials: "include" },
      );
      setRpcConfigs(res.data);
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : "failed to load RPC configs");
    } finally {
      setRpcLoading(false);
    }
  }, []);

  const loadRpcNetworks = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: RpcNetwork[]; meta: { total: number } }>(
        "/modules/chain/networks",
        { credentials: "include" },
      );
      setRpcNetworks(res.data);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    if (section === "slack") fetchSlackStatus();
    if (section === "webhook") fetchWebhookConfig();
    if (section === "channels") fetchChannels();
    if (section === "rpc") { fetchRpcConfigs(); loadRpcNetworks(); }
  }, [section, fetchSlackStatus, fetchWebhookConfig, fetchChannels, fetchRpcConfigs, loadRpcNetworks]);

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

  /* ── CDN providers ─────────────────────────────────────────── */

  const fetchCdnProviders = useCallback(async () => {
    setCdnLoading(true);
    setCdnError(null);
    try {
      const res = await apiFetch<{ data: CdnProvider[] }>("/modules/infra/cdn-providers", { credentials: "include" });
      setCdnProviders(res.data);
    } catch (err) {
      setCdnError(err instanceof Error ? err.message : "Failed to load CDN providers");
    } finally {
      setCdnLoading(false);
    }
  }, []);

  useEffect(() => {
    if (section === "cdn-providers") fetchCdnProviders();
  }, [section, fetchCdnProviders]);

  function resetAddCdnForm() {
    setAddCdnDisplayName("");
    setAddCdnHostPattern("");
    setCfApiToken("");
    setCfAccountId("");
    setAwsAccessKey("");
    setAwsSecretKey("");
    setAwsRegion("us-east-1");
    setAddCdnError(null);
  }

  async function handleAddCdnProvider(e: React.FormEvent) {
    e.preventDefault();
    setAddCdnError(null);
    if (!addCdnDisplayName.trim()) { setAddCdnError("Display name is required."); return; }
    let credentials: Record<string, string>;
    if (addCdnProvider === "cloudflare") {
      if (!cfApiToken.trim() || !cfAccountId.trim()) { setAddCdnError("API Token and Account ID are required for Cloudflare."); return; }
      credentials = { apiToken: cfApiToken, accountId: cfAccountId };
    } else {
      if (!awsAccessKey.trim() || !awsSecretKey.trim()) { setAddCdnError("Access Key ID and Secret Access Key are required for CloudFront."); return; }
      credentials = { accessKeyId: awsAccessKey, secretAccessKey: awsSecretKey, region: awsRegion };
    }
    setAddCdnLoading(true);
    try {
      const res = await apiFetch<{ data: CdnProvider }>("/modules/infra/cdn-providers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: addCdnProvider, displayName: addCdnDisplayName.trim(), credentials, hostPattern: addCdnHostPattern.trim() || undefined }),
      });
      setCdnProviders((prev) => [...prev, res.data]);
      setShowAddCdn(false);
      resetAddCdnForm();
      toast("CDN provider added.");
    } catch (err) {
      setAddCdnError(err instanceof Error ? err.message : "Failed to add CDN provider");
    } finally {
      setAddCdnLoading(false);
    }
  }

  async function validateCdnProvider(provider: CdnProvider) {
    setCdnActionLoading((prev) => ({ ...prev, [`validate-${provider.id}`]: true }));
    try {
      const res = await apiFetch<{ data: { valid: boolean; message: string } }>(
        `/modules/infra/cdn-providers/${provider.id}/validate`,
        { method: "POST", credentials: "include" },
      );
      setCdnProviders((prev) => prev.map((p) => p.id === provider.id ? { ...p, isValid: res.data.valid, lastValidatedAt: new Date().toISOString() } : p));
      toast(res.data.valid ? "Validation passed." : `Validation failed: ${res.data.message}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setCdnActionLoading((prev) => ({ ...prev, [`validate-${provider.id}`]: false }));
    }
  }

  async function removeCdnProvider(provider: CdnProvider) {
    const confirmed = await confirm("Remove CDN Provider", `Remove "${provider.displayName}"? This cannot be undone.`);
    if (!confirmed) return;
    setCdnActionLoading((prev) => ({ ...prev, [provider.id]: true }));
    try {
      await apiFetch(`/modules/infra/cdn-providers/${provider.id}`, { method: "DELETE", credentials: "include" });
      setCdnProviders((prev) => prev.filter((p) => p.id !== provider.id));
      toast("CDN provider removed.");
    } catch {
      toast("Failed to remove CDN provider.");
    } finally {
      setCdnActionLoading((prev) => ({ ...prev, [provider.id]: false }));
    }
  }

  async function loadCdnHosts() {
    setCdnHostsLoading(true);
    try {
      const res = await apiFetch<{ data: { id: string; hostname: string }[] }>("/modules/infra/hosts?limit=100", { credentials: "include" });
      setCdnHosts(res.data);
    } catch {
      toast("Failed to load hosts.");
    } finally {
      setCdnHostsLoading(false);
    }
  }

  async function runProxyCheck() {
    if (selectedCdnHostIds.size === 0) return;
    setProxyChecking(true);
    try {
      const res = await apiFetch<{ data: ProxyCheckResult[] }>("/modules/infra/cdn-providers/check-proxy", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostIds: Array.from(selectedCdnHostIds) }),
      });
      setProxyResults(res.data);
      toast(`Checked ${res.data.length} hosts.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Proxy check failed");
    } finally {
      setProxyChecking(false);
    }
  }

  /* ── Slack connect / disconnect ────────────────────────────── */

  async function connectSlack() {
    try {
      const res = await apiFetch<{ url: string }>("/integrations/slack/install", {
        credentials: "include",
      });
      if (!/^https?:\/\//i.test(res.url)) {
        throw new Error("Invalid redirect URL received from server");
      }
      window.location.href = res.url;
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to start Slack OAuth flow",
      );
    }
  }

  async function disconnectSlack() {
    const confirmed = await confirm(
      "Disconnect Slack",
      "This will remove the Slack integration. Alert notifications to Slack channels will stop working.",
    );
    if (!confirmed) return;
    try {
      await apiFetch("/integrations/slack", {
        method: "DELETE",
        credentials: "include",
      });
      setSlackStatus({ connected: false });
      toast("Slack disconnected.");
    } catch {
      toast("Failed to disconnect Slack.");
    }
  }

  /* ── rotate webhook secret ──────────────────────────────────── */

  async function rotateWebhookSecret() {
    const confirmed = await confirm(
      "Rotate Webhook Secret",
      "Rotating the secret will immediately invalidate the current one. You must update the secret in Docker Hub and npm webhook settings.",
    );
    if (!confirmed) return;
    setRotateLoading(true);
    setNewSecret(null);
    try {
      const res = await apiFetch<{ secret: string; secretPrefix: string }>(
        "/modules/registry/webhook-config/rotate",
        { method: "POST", credentials: "include" },
      );
      setNewSecret(res.secret);
      fetchWebhookConfig();
      toast("Webhook secret rotated.");
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to rotate webhook secret",
      );
    } finally {
      setRotateLoading(false);
    }
  }

  /* ── channels ───────────────────────────────────────────────── */

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault();
    setCreateChannelLoading(true);
    try {
      const config: Record<string, unknown> =
        createChannelType === "webhook"
          ? { url: createChannelUrl }
          : { recipients: createChannelRecipients.split(",").map((r) => r.trim()).filter(Boolean) };
      const res = await apiFetch<{ data: Channel; generatedSecret?: string }>("/api/channels", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createChannelName, type: createChannelType, config }),
      });
      setChannels((prev) => [res.data, ...prev]);
      setShowCreateChannel(false);
      setCreateChannelName("");
      setCreateChannelUrl("");
      setCreateChannelRecipients("");
      if (res.generatedSecret) {
        toast(`Channel created. Webhook secret: ${res.generatedSecret} — save this now.`);
      } else {
        toast("Channel created.");
      }
    } catch (err) {
      toast(err instanceof Error ? `Failed: ${err.message}` : "Failed to create channel");
    } finally {
      setCreateChannelLoading(false);
    }
  }

  async function testChannel(channel: Channel) {
    setChannelActionLoading((prev) => ({ ...prev, [`test-${channel.id}`]: true }));
    try {
      await apiFetch(`/api/channels/${channel.id}/test`, { method: "POST", credentials: "include" });
      toast(`Test notification sent to "${channel.name}".`);
    } catch (err) {
      toast(err instanceof Error ? `Test failed: ${err.message}` : "Test notification failed");
    } finally {
      setChannelActionLoading((prev) => ({ ...prev, [`test-${channel.id}`]: false }));
    }
  }

  async function toggleChannelEnabled(channel: Channel) {
    setChannelActionLoading((prev) => ({ ...prev, [channel.id]: true }));
    try {
      await apiFetch(`/api/channels/${channel.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      setChannels((prev) => prev.map((c) => c.id === channel.id ? { ...c, enabled: !c.enabled } : c));
    } catch {
      toast("Failed to update channel.");
    } finally {
      setChannelActionLoading((prev) => ({ ...prev, [channel.id]: false }));
    }
  }

  async function deleteChannel(channel: Channel) {
    const confirmed = await confirm(
      "Delete Channel",
      `Are you sure you want to delete "${channel.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;
    setChannelActionLoading((prev) => ({ ...prev, [channel.id]: true }));
    try {
      await apiFetch(`/api/channels/${channel.id}`, { method: "DELETE", credentials: "include" });
      setChannels((prev) => prev.filter((c) => c.id !== channel.id));
      toast(`Channel "${channel.name}" deleted.`);
    } catch {
      toast("Failed to delete channel.");
    } finally {
      setChannelActionLoading((prev) => ({ ...prev, [channel.id]: false }));
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

  /* ── RPC config actions ─────────────────────────────────────── */

  async function handleAddRpcConfig(e: React.FormEvent) {
    e.preventDefault();
    if (!addRpcNetworkId || !addRpcUrl) return;
    setAddingRpc(true);
    try {
      await apiFetch("/modules/chain/rpc-configs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ networkId: Number(addRpcNetworkId), customUrl: addRpcUrl }),
      });
      toast("RPC config saved", "success");
      setAddRpcNetworkId("");
      setAddRpcUrl("");
      setShowAddRpcForm(false);
      fetchRpcConfigs();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save RPC config");
    } finally {
      setAddingRpc(false);
    }
  }

  async function toggleRpcConfig(config: RpcConfig) {
    const newStatus = config.status === "active" ? "inactive" : "active";
    try {
      await apiFetch(`/modules/chain/rpc-configs/${config.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setRpcConfigs((prev) =>
        prev.map((c) => c.id === config.id ? { ...c, status: newStatus } : c),
      );
    } catch {
      toast("Failed to update RPC config");
    }
  }

  async function deleteRpcConfig(configId: number) {
    try {
      await apiFetch(`/modules/chain/rpc-configs/${configId}`, {
        method: "DELETE",
        credentials: "include",
      });
      setRpcConfigs((prev) => prev.filter((c) => c.id !== configId));
      toast("RPC config removed", "success");
    } catch {
      toast("Failed to remove RPC config");
    }
  }

  /* ── render ────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
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
      <div className="flex border-b border-border">
        {(
          [
            { key: "members", label: "members" },
            { key: "api-keys", label: "api-keys" },
            { key: "invite", label: "invite" },
            { key: "notify-key", label: "notify-key" },
            { key: "slack", label: "slack" },
            { key: "webhook", label: "webhooks" },
            { key: "channels", label: "channels" },
            { key: "rpc", label: "rpc" },
            { key: "cdn-providers", label: "cdn" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={cn(
              "px-4 py-2 text-xs font-mono whitespace-nowrap transition-colors border-b-2 -mb-px shrink-0",
              section === key
                ? "border-primary text-primary text-glow"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
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

      {/* ── Slack Section ─────────────────────────────────────── */}
      {section === "slack" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            $ integrations slack status
          </p>

          <Card>
            <CardContent className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                {">"} slack must be connected for alert notifications to reach
                your channels.
              </p>

              {slackLoading ? (
                <p className="text-xs text-muted-foreground">loading...</p>
              ) : slackStatus?.connected ? (
                <>
                  <div className="text-xs">
                    <span className="text-muted-foreground">status: </span>
                    <span className="text-primary">[connected]</span>
                    {slackStatus.teamName && (
                      <span className="ml-3 text-muted-foreground">
                        workspace: {slackStatus.teamName}
                      </span>
                    )}
                    {slackStatus.installedAt && (
                      <span className="ml-3 text-muted-foreground">
                        connected{" "}
                        {new Date(slackStatus.installedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={disconnectSlack}
                    className="text-destructive"
                  >
                    $ disconnect
                  </Button>
                </>
              ) : (
                <>
                  <div className="text-xs">
                    <span className="text-muted-foreground">status: </span>
                    <span className="text-muted-foreground">[not connected]</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={connectSlack}
                  >
                    $ connect slack
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Webhook Section ───────────────────────────────────── */}
      {section === "webhook" && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            $ registry webhook-config
          </p>

          {webhookConfigLoading ? (
            <div className="animate-pulse space-y-2">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="h-12 rounded bg-muted-foreground/10"
                />
              ))}
            </div>
          ) : webhookConfig ? (
            <>
              <Card>
                <CardContent className="p-4 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {">"} configure these URLs in Docker Hub and npm webhook
                    settings along with the shared secret.
                  </p>

                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      --docker-webhook-url
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 break-all rounded border border-border bg-background px-3 py-2 font-mono text-xs text-primary">
                        {webhookConfig.webhookUrl}
                      </code>
                      <button
                        onClick={() =>
                          navigator.clipboard
                            .writeText(webhookConfig.webhookUrl)
                            .then(() => toast("Copied to clipboard."))
                        }
                        className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                      >
                        [copy]
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      --npm-webhook-url
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 break-all rounded border border-border bg-background px-3 py-2 font-mono text-xs text-primary">
                        {webhookConfig.npmWebhookUrl}
                      </code>
                      <button
                        onClick={() =>
                          navigator.clipboard
                            .writeText(webhookConfig.npmWebhookUrl)
                            .then(() => toast("Copied to clipboard."))
                        }
                        className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                      >
                        [copy]
                      </button>
                    </div>
                  </div>

                  <div className="text-xs">
                    <span className="text-muted-foreground">
                      --webhook-secret:{" "}
                    </span>
                    <span
                      className={
                        webhookConfig.hasSecret
                          ? "text-primary"
                          : "text-muted-foreground"
                      }
                    >
                      {webhookConfig.hasSecret ? "[configured]" : "[not set]"}
                    </span>
                    {webhookConfig.secretPrefix && (
                      <span className="ml-3 text-muted-foreground">
                        prefix: {webhookConfig.secretPrefix}
                      </span>
                    )}
                  </div>

                  {newSecret && (
                    <div className="border border-border bg-background p-3">
                      <p className="mb-1 text-xs text-warning">
                        [!] save this secret — it will never be shown again.
                      </p>
                      <p className="break-all font-mono text-xs text-primary text-glow">
                        {newSecret}
                      </p>
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={rotateWebhookSecret}
                    disabled={rotateLoading}
                  >
                    {rotateLoading
                      ? "..."
                      : webhookConfig.hasSecret
                        ? "$ rotate secret"
                        : "$ generate secret"}
                  </Button>
                </CardContent>
              </Card>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {">"} failed to load webhook configuration.
            </p>
          )}
        </div>
      )}

      {/* ── Channels Section ──────────────────────────────────── */}
      {section === "channels" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">$ channels ls</p>
            <Button size="sm" onClick={() => setShowCreateChannel(!showCreateChannel)}>
              {showCreateChannel ? "[cancel]" : "+ New Channel"}
            </Button>
          </div>

          {showCreateChannel && (
            <Card>
              <CardContent className="p-4">
                <p className="mb-3 text-xs text-muted-foreground">$ channels create</p>
                <form onSubmit={handleCreateChannel} className="space-y-3">
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-muted-foreground">--type</span>
                    <button
                      type="button"
                      onClick={() => setCreateChannelType("webhook")}
                      className={cn(
                        "transition-colors",
                        createChannelType === "webhook" ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground",
                      )}
                    >
                      {createChannelType === "webhook" ? "[webhook]" : "webhook"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreateChannelType("email")}
                      className={cn(
                        "transition-colors",
                        createChannelType === "email" ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground",
                      )}
                    >
                      {createChannelType === "email" ? "[email]" : "email"}
                    </button>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">--name</label>
                    <Input placeholder="channel name" value={createChannelName} onChange={(e) => setCreateChannelName(e.target.value)} required />
                  </div>
                  {createChannelType === "webhook" ? (
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">--url</label>
                      <Input type="url" placeholder="https://hooks.example.com/..." value={createChannelUrl} onChange={(e) => setCreateChannelUrl(e.target.value)} required />
                    </div>
                  ) : (
                    <div>
                      <label className="mb-1 block text-xs text-muted-foreground">--recipients (comma-separated)</label>
                      <Input placeholder="user@example.com, admin@example.com" value={createChannelRecipients} onChange={(e) => setCreateChannelRecipients(e.target.value)} required />
                    </div>
                  )}
                  <Button type="submit" disabled={createChannelLoading}>
                    {createChannelLoading ? "> creating..." : "$ create"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          <div className="min-h-[200px]">
            {(showChannelsLoading || channelsLoading) && (
              <div className={showChannelsLoading ? "py-16 text-center" : "py-16 text-center invisible"}>
                <p className="text-sm text-primary">{"> loading channels..."}<span className="ml-1 animate-pulse">_</span></p>
              </div>
            )}
            {!showChannelsLoading && !channelsLoading && channelsError && (
              <div className="py-16 text-center">
                <p className="text-sm text-destructive">[ERR] {channelsError}</p>
                <Button variant="outline" size="sm" className="mt-4 text-xs" onClick={fetchChannels}>$ retry</Button>
              </div>
            )}
            {!showChannelsLoading && !channelsLoading && !channelsError && channels.length === 0 && (
              <div className="py-16 text-center">
                <p className="text-sm text-muted-foreground">{">"} no channels configured. create one to receive notifications.</p>
              </div>
            )}
            {!showChannelsLoading && !channelsLoading && !channelsError && channels.length > 0 && (
              <div className="space-y-2 animate-content-ready">
                {channels.map((channel) => {
                  const busy = channelActionLoading[channel.id] ?? false;
                  const testBusy = channelActionLoading[`test-${channel.id}`] ?? false;
                  return (
                    <Card key={channel.id}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-foreground">{channel.name}</span>
                              <span className="text-xs text-muted-foreground">[{channel.type}]</span>
                              <span className={cn("text-xs", channel.enabled ? "text-primary" : "text-muted-foreground")}>
                                {channel.enabled ? "[enabled]" : "[disabled]"}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {channel.type === "webhook" && <span>url: {(channel.config.url as string) ?? "not set"}</span>}
                              {channel.type === "email" && <span>recipients: {((channel.config.recipients as string[]) ?? []).join(", ") || "none"}</span>}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">created {new Date(channel.createdAt).toLocaleDateString()}</p>
                          </div>
                          <div className="flex items-center gap-2 text-xs shrink-0">
                            <button disabled={testBusy || !channel.enabled} onClick={() => testChannel(channel)} className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50">
                              {testBusy ? "..." : "[test]"}
                            </button>
                            <button disabled={busy} onClick={() => toggleChannelEnabled(channel)} className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50">
                              {busy ? "..." : channel.enabled ? "[disable]" : "[enable]"}
                            </button>
                            <button disabled={busy} onClick={() => deleteChannel(channel)} className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50">
                              [delete]
                            </button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── RPC Config Section ───────────────────────────────── */}
      {section === "rpc" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">$ chain rpc-configs ls</p>
            <Button onClick={() => setShowAddRpcForm(!showAddRpcForm)}>
              {showAddRpcForm ? "Cancel" : "+ Add RPC Config"}
            </Button>
          </div>

          {showAddRpcForm && (
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-3">$ chain rpc-configs add</p>
                <form onSubmit={handleAddRpcConfig} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">--network</label>
                      <Select
                        value={addRpcNetworkId}
                        onValueChange={setAddRpcNetworkId}
                        options={[
                          { value: "", label: "select network..." },
                          ...rpcNetworks.map((n) => ({
                            value: String(n.id),
                            label: `${n.name} (${n.chainId})`,
                          })),
                        ]}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">--url</label>
                      <Input
                        value={addRpcUrl}
                        onChange={(e) => setAddRpcUrl(e.target.value)}
                        placeholder="https://mainnet.infura.io/v3/..."
                        className="h-8 text-xs"
                        required
                      />
                    </div>
                  </div>
                  <Button type="submit" size="sm" disabled={addingRpc}>
                    {addingRpc ? "saving..." : "$ submit"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          <div className="min-h-[200px]">
            {(showRpcLoading || rpcLoading) && (
              <div className={showRpcLoading ? "py-16 text-center" : "py-16 text-center invisible"}>
                <p className="text-sm text-primary">{">"} loading rpc configs...<span className="ml-1 animate-pulse">_</span></p>
              </div>
            )}
            {!showRpcLoading && !rpcLoading && rpcError && (
              <div className="py-16 text-center">
                <p className="text-sm text-destructive">[ERR] {rpcError}</p>
                <Button variant="outline" size="sm" className="mt-4 text-xs" onClick={fetchRpcConfigs}>$ retry</Button>
              </div>
            )}
            {!showRpcLoading && !rpcLoading && !rpcError && rpcConfigs.length === 0 && (
              <div className="py-16 text-center">
                <p className="text-sm text-muted-foreground">{">"} no custom RPC configs found</p>
                <p className="mt-1 text-xs text-muted-foreground">add a custom RPC endpoint to override the default for a network</p>
                <Button className="mt-4" onClick={() => setShowAddRpcForm(true)}>+ Add RPC Config</Button>
              </div>
            )}
            {!showRpcLoading && !rpcLoading && !rpcError && rpcConfigs.length > 0 && (
              <div className="overflow-x-auto animate-content-ready">
                <div className="min-w-[700px]">
                  <div className="grid grid-cols-[minmax(100px,1fr)_minmax(200px,2fr)_80px_80px_80px_80px_1fr] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <span>Network</span>
                    <span>Custom URL</span>
                    <span>Status</span>
                    <span>Calls</span>
                    <span>Errors</span>
                    <span>Latency</span>
                    <span className="text-right">Actions</span>
                  </div>
                  <p className="px-3 pt-2 text-xs text-muted-foreground">
                    {rpcConfigs.length} config{rpcConfigs.length !== 1 ? "s" : ""}
                  </p>
                  {rpcConfigs.map((config) => (
                    <div
                      key={config.id}
                      className="group grid grid-cols-[minmax(100px,1fr)_minmax(200px,2fr)_80px_80px_80px_80px_1fr] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30"
                    >
                      <span className="text-foreground font-medium text-xs">{config.networkName}</span>
                      <span className="text-muted-foreground text-xs truncate">{config.customUrl}</span>
                      <span className={cn("font-mono text-xs", config.status === "active" ? "text-primary" : config.status === "error" ? "text-destructive" : "text-muted-foreground")}>
                        [{config.status}]
                      </span>
                      <span className="text-primary text-xs">{config.callCount.toLocaleString()}</span>
                      <span className={cn("text-xs", config.errorCount > 0 ? "text-destructive" : "text-muted-foreground")}>
                        {config.errorCount.toLocaleString()}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {config.avgLatencyMs !== null ? `${config.avgLatencyMs}ms` : "--"}
                      </span>
                      <span className="flex items-center justify-end gap-2 text-xs">
                        <button onClick={() => toggleRpcConfig(config)} className="text-muted-foreground hover:text-primary transition-colors">
                          {config.status === "active" ? "[disable]" : "[enable]"}
                        </button>
                        <button onClick={() => deleteRpcConfig(config.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                          [remove]
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CDN Providers Section ─────────────────────────────── */}
      {section === "cdn-providers" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">$ infra cdn-providers</p>
            <Button onClick={() => { setShowAddCdn(!showAddCdn); if (showAddCdn) resetAddCdnForm(); }}>
              {showAddCdn ? "[cancel]" : "+ Add Provider"}
            </Button>
          </div>

          {showAddCdn && (
            <Card>
              <CardContent className="p-4">
                <form onSubmit={handleAddCdnProvider} className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">provider</label>
                    <div className="flex gap-2">
                      {(["cloudflare", "cloudfront"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setAddCdnProvider(p)}
                          className={cn(
                            "px-3 py-1 text-xs border transition-colors",
                            addCdnProvider === p
                              ? "border-primary text-primary"
                              : "border-border text-muted-foreground hover:text-foreground",
                          )}
                        >
                          [{p}]
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">display name</label>
                    <Input
                      type="text"
                      placeholder="My Cloudflare Account"
                      value={addCdnDisplayName}
                      onChange={(e) => setAddCdnDisplayName(e.target.value)}
                    />
                  </div>

                  {addCdnProvider === "cloudflare" ? (
                    <>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">api token</label>
                        <Input type="password" placeholder="Cloudflare API Token" value={cfApiToken} onChange={(e) => setCfApiToken(e.target.value)} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">account id</label>
                        <Input type="text" placeholder="Cloudflare Account ID" value={cfAccountId} onChange={(e) => setCfAccountId(e.target.value)} />
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">access key id</label>
                        <Input type="text" placeholder="AWS Access Key ID" value={awsAccessKey} onChange={(e) => setAwsAccessKey(e.target.value)} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">secret access key</label>
                        <Input type="password" placeholder="AWS Secret Access Key" value={awsSecretKey} onChange={(e) => setAwsSecretKey(e.target.value)} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-muted-foreground">region</label>
                        <Input type="text" placeholder="us-east-1" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} />
                      </div>
                    </>
                  )}

                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">host pattern (optional)</label>
                    <Input type="text" placeholder="*.example.com" value={addCdnHostPattern} onChange={(e) => setAddCdnHostPattern(e.target.value)} />
                  </div>

                  {addCdnError && <p className="text-xs text-destructive">[ERR] {addCdnError}</p>}

                  <Button type="submit" disabled={addCdnLoading}>
                    {addCdnLoading ? "> adding..." : "$ add provider"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          <div className="min-h-[150px]">
            {showCdnLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2">
                    <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : cdnError ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <p className="text-sm text-destructive">[ERR] {cdnError}</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={fetchCdnProviders}>$ retry</Button>
                </CardContent>
              </Card>
            ) : cdnProviders.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">{">"} no CDN providers configured</p>
                  <Button className="mt-4" onClick={() => setShowAddCdn(true)}>+ Add Provider</Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground px-2">
                  {cdnProviders.length} provider{cdnProviders.length !== 1 ? "s" : ""} configured
                </p>
                {cdnProviders.map((provider) => {
                  const busy = cdnActionLoading[provider.id] ?? false;
                  const validateBusy = cdnActionLoading[`validate-${provider.id}`] ?? false;
                  return (
                    <Card key={provider.id}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 text-sm flex-wrap">
                            <span className="text-primary font-mono">[{provider.provider}]</span>
                            <span className="text-foreground">{provider.displayName}</span>
                            {provider.hostPattern && (
                              <span className="text-xs text-muted-foreground">pattern: {provider.hostPattern}</span>
                            )}
                            <span className={cn("text-xs font-mono", provider.isValid ? "text-primary" : "text-destructive")}>
                              {provider.isValid ? "[OK]" : "[!!] invalid"}
                            </span>
                            {provider.lastValidatedAt && (
                              <span className="text-xs text-muted-foreground">
                                checked: {new Date(provider.lastValidatedAt).toLocaleString()}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs shrink-0">
                            <button disabled={validateBusy} onClick={() => validateCdnProvider(provider)} className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50">
                              {validateBusy ? "..." : "[validate]"}
                            </button>
                            <button disabled={busy} onClick={() => removeCdnProvider(provider)} className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50">
                              {busy ? "..." : "[delete]"}
                            </button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Proxy Detection Tool */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-muted-foreground">$ cdn-providers check-proxy</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowProxyCheck(!showProxyCheck);
                    if (!showProxyCheck && cdnHosts.length === 0) loadCdnHosts();
                  }}
                >
                  {showProxyCheck ? "[-] collapse" : "[+] proxy check"}
                </Button>
              </div>

              {showProxyCheck && (
                <div className="space-y-4">
                  {cdnHostsLoading ? (
                    <p className="text-xs text-muted-foreground animate-pulse">loading hosts...</p>
                  ) : cdnHosts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{">"} no hosts available</p>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setSelectedCdnHostIds(selectedCdnHostIds.size === cdnHosts.length ? new Set() : new Set(cdnHosts.map((h) => h.id)))}
                          className="text-xs text-muted-foreground hover:text-primary transition-colors"
                        >
                          {selectedCdnHostIds.size === cdnHosts.length ? "[deselect all]" : "[select all]"}
                        </button>
                        <span className="text-xs text-muted-foreground">{selectedCdnHostIds.size} selected</span>
                      </div>

                      <div className="max-h-48 overflow-y-auto border border-border">
                        {cdnHosts.map((host) => (
                          <label key={host.id} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedCdnHostIds.has(host.id)}
                              onChange={() => setSelectedCdnHostIds((prev) => { const next = new Set(prev); if (next.has(host.id)) { next.delete(host.id); } else { next.add(host.id); } return next; })}
                              className="accent-primary"
                            />
                            <span className="text-foreground font-mono">{host.hostname}</span>
                          </label>
                        ))}
                      </div>

                      <Button size="sm" disabled={proxyChecking || selectedCdnHostIds.size === 0} onClick={runProxyCheck}>
                        {proxyChecking ? "> checking..." : `$ check-proxy (${selectedCdnHostIds.size})`}
                      </Button>
                    </>
                  )}

                  {proxyResults.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs text-muted-foreground mb-2">results:</p>
                      <div className="overflow-x-auto">
                        <div className="min-w-[600px]">
                          <div className="grid grid-cols-[minmax(150px,2fr)_70px_100px_120px_80px] gap-x-3 border-b border-border px-2 py-1.5 text-xs text-muted-foreground uppercase tracking-wider">
                            <span>Hostname</span><span>Proxied</span><span>Provider</span><span>Method</span><span>Config</span>
                          </div>
                          {proxyResults.map((result) => (
                            <div key={result.hostId} className="grid grid-cols-[minmax(150px,2fr)_70px_100px_120px_80px] gap-x-3 px-2 py-1.5 text-xs border border-transparent hover:border-border hover:bg-muted/30 transition-colors">
                              <span className="text-foreground font-mono truncate">{result.hostname}</span>
                              <span className={cn("font-mono", result.isProxied ? "text-primary" : "text-muted-foreground")}>{result.isProxied ? "[OK]" : "[--]"}</span>
                              <span className="text-foreground">{result.provider || "--"}</span>
                              <span className="text-muted-foreground truncate">{result.detectionMethod || "--"}</span>
                              <span className={cn("font-mono", result.hasProviderConfig ? "text-primary" : "text-muted-foreground")}>{result.hasProviderConfig ? "[OK]" : "[--]"}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
