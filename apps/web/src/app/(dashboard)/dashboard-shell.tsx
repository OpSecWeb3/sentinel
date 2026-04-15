"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";

import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

/* ── nav config ──────────────────────────────────────────────── */

interface NavItem {
  title: string;
  href: string;
  icon: string;
}

interface ModuleNavItem {
  title: string;
  href: string;
  icon: string;
  children: { title: string; href: string }[];
}

const mainNav: NavItem[] = [
  { title: "dashboard", href: "/dashboard", icon: "~" },
  { title: "detections", href: "/detections", icon: "!" },
  { title: "correlations", href: "/correlations", icon: "#" },
  { title: "alerts", href: "/alerts", icon: "*" },
  { title: "channels", href: "/channels", icon: ">" },
  { title: "query", href: "/query", icon: "?" },
];

const moduleNav: ModuleNavItem[] = [
  {
    title: "github",
    href: "/github",
    icon: "@",
    children: [
      { title: "installations", href: "/github/installations" },
      { title: "repositories", href: "/github/repositories" },
    ],
  },
  {
    title: "registry",
    href: "/registry",
    icon: "%",
    children: [
      { title: "docker images", href: "/registry/images" },
      { title: "npm packages", href: "/registry/packages" },
    ],
  },
  {
    title: "chain",
    href: "/chain",
    icon: "&",
    children: [
      { title: "contracts", href: "/chain/contracts" },
    ],
  },
  {
    title: "infra",
    href: "/infra",
    icon: "^",
    children: [
      { title: "hosts", href: "/infra/hosts" },
      { title: "changes", href: "/infra/changes" },
    ],
  },
  {
    title: "aws",
    href: "/aws",
    icon: "$",
    children: [
      { title: "integrations", href: "/aws/integrations" },
      { title: "events", href: "/aws/events" },
    ],
  },
];

const bottomNav: NavItem[] = [
  { title: "settings", href: "/settings", icon: "=" },
];

const adminNav: NavItem[] = [
  { title: "logs", href: "/admin/logs", icon: "L" },
];

/* ── user types ──────────────────────────────────────────────── */

interface AuthUser {
  userId: string;
  orgId: string;
  role: string;
}

/* ── component ───────────────────────────────────────────────── */

export function DashboardShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(
    new Set(),
  );

  const checkAuth = useCallback(async () => {
    try {
      const res = await apiFetch<{ user: AuthUser; needsOrg: boolean }>(
        "/auth/me",
        { credentials: "include" },
      );
      if (res.needsOrg) {
        router.replace("/join-org");
        return;
      }
      setUser(res.user);
    } catch {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      router.replace(`/login?next=${next}`);
    } finally {
      setAuthLoading(false);
    }
  }, [router]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  /* Auto-expand module section if current path matches */
  useEffect(() => {
    for (const mod of moduleNav) {
      if (
        pathname === mod.href ||
        pathname.startsWith(mod.href + "/")
      ) {
        setExpandedModules((prev) => {
          const next = new Set(prev);
          next.add(mod.href);
          return next;
        });
      }
    }
  }, [pathname]);

  async function handleLogout() {
    try {
      await apiFetch("/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // proceed to redirect regardless
    }
    router.replace("/login");
  }

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname === href || pathname.startsWith(href + "/");
  }

  function isExactActive(href: string) {
    return pathname === href;
  }

  function toggleModule(href: string) {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(href)) {
        next.delete(href);
      } else {
        next.add(href);
      }
      return next;
    });
  }

  function renderNavItem(item: NavItem, isLast = false) {
    const active = isActive(item.href);
    const prefix = isLast ? "\u2514\u2500\u2500" : "\u251C\u2500\u2500";
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setSidebarOpen(false)}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-sm transition-colors",
          active
            ? "text-primary text-glow"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <span className="text-muted-foreground">{prefix}</span>
        <span>{item.title}/</span>
        {active && <span className="text-primary">{"<"}</span>}
      </Link>
    );
  }

  function renderModuleItem(mod: ModuleNavItem, isLastModule: boolean) {
    const active = isActive(mod.href);
    const expanded = expandedModules.has(mod.href);
    const prefix = isLastModule
      ? "\u2514\u2500\u2500"
      : "\u251C\u2500\u2500";

    return (
      <div key={mod.href}>
        {/* Module header (clickable to expand/collapse) */}
        <button
          onClick={() => toggleModule(mod.href)}
          className={cn(
            "flex w-full items-center gap-2 px-2 py-1.5 text-sm transition-colors text-left",
            active
              ? "text-primary text-glow"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="text-muted-foreground">{prefix}</span>
          <span>{mod.title}/</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {expanded ? "[-]" : "[+]"}
          </span>
        </button>

        {/* Sub-items (collapsible) */}
        {expanded && (
          <div>
            {mod.children.map((child, idx) => {
              const childActive = isExactActive(child.href);
              const isLastChild = idx === mod.children.length - 1;
              const childPrefix = isLastChild
                ? "\u2514\u2500\u2500"
                : "\u251C\u2500\u2500";

              return (
                <Link
                  key={child.href}
                  href={child.href}
                  onClick={() => setSidebarOpen(false)}
                  className={cn(
                    "flex items-center gap-2 pl-7 pr-2 py-1 text-sm transition-colors",
                    childActive
                      ? "text-primary text-glow"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="text-muted-foreground shrink-0">{childPrefix}</span>
                  <span>{child.title}</span>
                  {childActive && (
                    <span className="text-primary">{"<"}</span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  /* ── loading skeleton ──────────────────────────────────────── */

  if (authLoading) {
    return (
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden lg:flex w-64 flex-col border-r border-border bg-background">
          <div className="flex h-14 items-center gap-2 border-b border-border px-4">
            <span className="text-primary text-glow">$</span>
            <span className="text-sm font-bold tracking-wider text-foreground">
              SENTINEL
            </span>
            <span className="text-primary animate-pulse">_</span>
          </div>
          <nav className="flex-1 px-2 py-3">
            <div className="mb-2 px-2 text-xs text-muted-foreground">
              ~/sentinel/
            </div>
            {mainNav.map((item) => (
              <div
                key={item.href}
                className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground"
              >
                <span>{"\u251C\u2500\u2500"}</span>
                <span>{item.title}/</span>
              </div>
            ))}
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {"\u2514\u2500\u2500"} ...
            </div>
          </nav>
          <div className="border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">v0.1.0-alpha</p>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background px-4 sm:px-6">
            <div className="h-4 w-32 animate-pulse rounded bg-muted-foreground/20" />
          </header>
          <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <div className="space-y-4 animate-pulse">
              <div className="h-4 w-48 rounded bg-muted-foreground/20" />
              <div className="h-3 w-64 rounded bg-muted-foreground/10" />
            </div>
          </main>
        </div>
      </div>
    );
  }

  if (!user) {
    // Auth check completed but no user — redirect is already in-flight from
    // the catch block in checkAuth. Show the loading skeleton until the
    // navigation completes so the user never sees a blank screen.
    return (
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-64 flex-col border-r border-border bg-background lg:flex">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="text-sm font-bold tracking-wider text-foreground">
              SENTINEL
            </span>
            <span className="text-primary animate-pulse">_</span>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background px-4 sm:px-6">
            <div className="h-4 w-32 animate-pulse rounded bg-muted-foreground/20" />
          </header>
          <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <div className="space-y-4 animate-pulse">
              <div className="h-4 w-48 rounded bg-muted-foreground/20" />
              <div className="h-3 w-64 rounded bg-muted-foreground/10" />
            </div>
          </main>
        </div>
      </div>
    );
  }

  /* ── main layout ───────────────────────────────────────────── */

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-background transition-transform duration-200 lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <span className="text-primary text-glow">$</span>
          <span className="text-sm font-bold tracking-wider text-foreground">
            SENTINEL
          </span>
          <span className="text-primary animate-pulse">_</span>
          <button
            className="ml-auto flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            [x]
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <div className="mb-2 px-2 text-xs text-muted-foreground">
            ~/sentinel/
          </div>

          {/* Main navigation */}
          {mainNav.map((item, idx) =>
            renderNavItem(item, idx === mainNav.length - 1),
          )}

          {/* Separator */}
          <div className="my-3 border-t border-border" />

          {/* Module section */}
          <div className="mb-2 px-2 text-xs text-muted-foreground">
            modules/
          </div>
          {moduleNav.map((mod, idx) =>
            renderModuleItem(mod, idx === moduleNav.length - 1),
          )}

          {/* Separator */}
          <div className="my-3 border-t border-border" />

          {/* System nav */}
          <div className="mb-2 px-2 text-xs text-muted-foreground">
            system/
          </div>
          {bottomNav.map((item, idx) =>
            renderNavItem(item, idx === bottomNav.length - 1),
          )}

          {user?.role === "admin" && (
            <>
              <div className="my-3 border-t border-border" />
              <div className="mb-2 px-2 text-xs text-muted-foreground">
                admin/
              </div>
              {adminNav.map((item, idx) =>
                renderNavItem(item, idx === adminNav.length - 1),
              )}
            </>
          )}

          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {"\u2514\u2500\u2500"} ...
          </div>
        </nav>

        {/* Sidebar footer */}
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="truncate text-xs text-primary text-glow">
                [{user.userId.slice(0, 8)}]
              </p>
              <p className="text-xs text-muted-foreground">
                {user.role}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              [logout]
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">v0.1.0-alpha</p>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top header */}
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background px-4 sm:px-6">
          <button
            className="flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            [=]
          </button>

          <div className="flex-1">
            <span className="text-sm text-muted-foreground font-mono">
              sentinel:/{pathname.replace(/^\//, "")}
            </span>
          </div>

          <span className="text-xs text-muted-foreground">
            {user.role}@org
          </span>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
