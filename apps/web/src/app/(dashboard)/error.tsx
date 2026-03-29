"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="space-y-2">
        <p className="font-mono text-sm text-destructive">
          [ERR] DASHBOARD_ERROR
        </p>
        <h1 className="font-mono text-lg text-foreground">
          Something went wrong
        </h1>
        <p className="max-w-md font-mono text-sm text-muted-foreground">
          An error occurred while loading this page. The navigation sidebar is
          still available — you can switch to another section or retry.
        </p>
        {error.digest && (
          <p className="font-mono text-xs text-muted-foreground">
            ref: {error.digest}
          </p>
        )}
      </div>
      <button
        onClick={reset}
        className="rounded-sm border border-primary/40 bg-primary/10 px-4 py-2 font-mono text-sm text-primary transition-colors hover:bg-primary/20 focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {">"} Retry
      </button>
    </div>
  );
}
