import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://sentinel.dev"),
  title: {
    default: "Sentinel — Smart Contract Governance & Upgrade Management",
    template: "%s — Sentinel",
  },
  description:
    "Secure smart contract upgrade management and governance. Timelocks, multisig approvals, role-based access control, and automated safety checks for on-chain upgrades.",
  keywords: [
    "smart contract governance",
    "contract upgrade management",
    "timelock controller",
    "multisig approvals",
    "on-chain governance",
    "smart contract security",
    "upgrade safety",
    "proxy management",
    "web3 governance",
  ],
  authors: [{ name: "Sentinel" }],
  creator: "Sentinel",
  category: "Technology",
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
    title: "Sentinel — Smart Contract Governance & Upgrade Management",
    description:
      "Secure smart contract upgrade management and governance. Timelocks, multisig approvals, role-based access control, and automated safety checks.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sentinel — Smart Contract Governance & Upgrade Management",
    description:
      "Secure smart contract upgrade management and governance. Timelocks, multisig approvals, role-based access control, and automated safety checks.",
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
  url: "https://sentinel.dev",
  logo: "https://sentinel.dev/favicon.svg",
  description:
    "Secure smart contract upgrade management and governance platform.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${mono.variable} font-mono antialiased`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
