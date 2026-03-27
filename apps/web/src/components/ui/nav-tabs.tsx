"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface NavTab {
  href: string;
  label: string;
}

interface NavTabsProps {
  tabs: NavTab[];
  className?: string;
}

export function NavTabs({ tabs, className }: NavTabsProps) {
  const pathname = usePathname();

  return (
    <div className={cn("flex border-b border-border overflow-x-auto", className)}>
      {tabs.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-4 py-2 text-xs font-mono whitespace-nowrap transition-colors border-b-2 -mb-px",
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
