"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const BOOT_LINES = [
  { text: "[OK] detection engine loaded", delay: 0 },
  { text: "[OK] event streams connected", delay: 200 },
  { text: "[OK] alert dispatcher ready", delay: 400 },
  { text: "[OK] notification channels online", delay: 600 },
  { text: "> all systems operational", delay: 800, highlight: true },
];

export default function HomePage() {
  const router = useRouter();
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    const timers = BOOT_LINES.map((line, i) =>
      setTimeout(() => setVisibleLines(i + 1), line.delay),
    );
    const redirect = setTimeout(() => router.push("/login"), 1500);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(redirect);
    };
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center font-mono">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div>
          <p className="text-primary text-glow text-lg">$ sentinel --init</p>
          <p className="mt-1 text-xs text-muted-foreground">
            security event monitoring &amp; alerting
          </p>
        </div>

        <div className="space-y-1 text-xs">
          {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
            <p
              key={i}
              className={
                line.highlight ? "text-primary text-glow" : "text-muted-foreground"
              }
            >
              {line.text}
            </p>
          ))}
        </div>

        {visibleLines > 0 && (
          <p className="text-xs text-muted-foreground">
            <span className="typing-cursor"> </span>
          </p>
        )}
      </div>
    </div>
  );
}
