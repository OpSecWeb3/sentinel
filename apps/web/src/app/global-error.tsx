"use client";

/**
 * global-error.tsx catches errors that occur in the root layout itself.
 * It must render its own <html> and <body> tags because the root layout
 * is replaced when this boundary activates.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          backgroundColor: "hsl(0 0% 3%)",
          color: "hsl(0 0% 85%)",
          fontFamily:
            '"JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, monospace',
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          textAlign: "center",
          padding: "1rem",
        }}
      >
        <div>
          <p
            style={{
              fontSize: "0.875rem",
              color: "hsl(0 72% 51%)",
              marginBottom: "0.5rem",
            }}
          >
            [ERR] CRITICAL_FAILURE
          </p>
          <h1 style={{ fontSize: "1.125rem", marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p
            style={{
              fontSize: "0.875rem",
              color: "hsl(0 0% 50%)",
              maxWidth: "28rem",
              marginBottom: "1.5rem",
            }}
          >
            A critical error prevented the application from rendering. You can
            try again or refresh the page.
          </p>
          {error?.digest && (
            <p
              style={{
                fontSize: "0.75rem",
                color: "hsl(0 0% 50%)",
                marginBottom: "1.5rem",
              }}
            >
              ref: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              fontFamily: "inherit",
              fontSize: "0.875rem",
              color: "hsl(142 71% 45%)",
              backgroundColor: "hsla(142, 71%, 45%, 0.1)",
              border: "1px solid hsla(142, 71%, 45%, 0.4)",
              borderRadius: "2px",
              padding: "0.5rem 1rem",
              cursor: "pointer",
            }}
          >
            {">"} Retry
          </button>
        </div>
      </body>
    </html>
  );
}
