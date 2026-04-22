import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://sentinel.chainalert.dev"),
  title: {
    default: "Sentinel — Security Monitoring & Threat Detection",
    template: "%s — Sentinel",
  },
  description:
    "Real-time security monitoring across blockchain, infrastructure, GitHub, and AWS. Detect threats, trigger alerts, and manage incidents with automated detection rules and multi-channel notifications.",
  keywords: [
    "security monitoring",
    "threat detection",
    "blockchain monitoring",
    "smart contract security",
    "infrastructure monitoring",
    "on-chain alerts",
    "web3 security",
    "DeFi security",
    "automated alerting",
  ],
  authors: [{ name: "Sentinel" }],
  creator: "Sentinel",
  category: "Technology",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "48x48" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    siteName: "Sentinel",
    locale: "en_US",
    title: "Sentinel — Security Monitoring & Threat Detection",
    description:
      "Real-time security monitoring across blockchain, infrastructure, GitHub, and AWS. Detect threats and get instant alerts via Slack, email, or webhooks.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sentinel — Security Monitoring & Threat Detection",
    description:
      "Real-time security monitoring across blockchain, infrastructure, GitHub, and AWS. Detect threats and get instant alerts via Slack, email, or webhooks.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Sentinel",
  url: "https://sentinel.chainalert.dev",
  logo: "https://sentinel.chainalert.dev/favicon.svg",
  description:
    "Real-time security monitoring and threat detection across blockchain, infrastructure, GitHub, and AWS.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${mono.variable} ${sans.variable} font-mono antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
