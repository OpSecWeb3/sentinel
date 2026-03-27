"use client";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 font-mono">
      <div className="w-full max-w-md">
        {/* Terminal header */}
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold tracking-wider text-primary text-glow">
            $ SENTINEL
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} security monitoring platform
          </p>
        </div>

        {/* Auth card */}
        <div className="border border-border bg-card p-6 shadow-lg">
          {children}
        </div>

        {/* Footer */}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          v0.1.0-alpha
        </p>
      </div>
    </div>
  );
}
