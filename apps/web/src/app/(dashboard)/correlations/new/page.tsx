"use client";

import Link from "next/link";
import { CorrelationRuleForm } from "@/components/correlation-rule-form";

export default function NewCorrelationRulePage() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/correlations" className="hover:text-primary transition-colors">
          correlations
        </Link>
        <span>/</span>
        <span className="text-foreground">new</span>
      </div>

      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ correlation create
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} define a multi-event correlation rule
        </p>
      </div>

      <CorrelationRuleForm mode="create" />
    </div>
  );
}
