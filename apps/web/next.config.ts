import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";
const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
// Extract the Sentry ingest host from the DSN so it can be added to CSP.
const sentryHost = sentryDsn ? new URL(sentryDsn).origin : "";

const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  // Next.js App Router requires unsafe-inline for styles and inline scripts.
  // Tighten to a nonce-based policy once the app is stable.
  // unsafe-eval is only needed for Turbopack HMR in development.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${apiUrl} ${sentryHost}`.trim(),
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Suppress source map upload warnings when SENTRY_AUTH_TOKEN is not set (local dev).
  silent: !process.env.SENTRY_AUTH_TOKEN,
  disableLogger: true,
});
