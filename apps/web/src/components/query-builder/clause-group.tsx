"use client";

import type { ClauseGroup as ClauseGroupType, Collection, Clause } from "./types";
import { ClauseRow } from "./clause-row";
import { defaultClause } from "./utils";
import { cn } from "@/lib/utils";

interface ClauseGroupProps {
  group: ClauseGroupType;
  collection: Collection;
  onChange: (updated: ClauseGroupType) => void;
  onRemove: () => void;
  canRemove: boolean;
}

export function ClauseGroup({ group, collection, onChange, onRemove, canRemove }: ClauseGroupProps) {
  const updateClause = (idx: number, clause: Clause) => {
    const clauses = [...group.clauses];
    clauses[idx] = clause;
    onChange({ ...group, clauses });
  };

  const removeClause = (idx: number) => {
    onChange({ ...group, clauses: group.clauses.filter((_: Clause, i: number) => i !== idx) });
  };

  const addClause = () => {
    onChange({ ...group, clauses: [...group.clauses, defaultClause()] });
  };

  const toggleLogic = () => {
    onChange({ ...group, logic: group.logic === 'AND' ? 'OR' : 'AND' });
  };

  return (
    <div className="border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleLogic}
            className={cn(
              "px-2 py-0.5 text-xs font-mono border transition-colors",
              group.logic === "OR"
                ? "border-yellow-500/50 text-yellow-500"
                : "border-primary/50 text-primary",
            )}
          >
            {group.logic}
          </button>
          <span className="text-xs text-muted-foreground">
            {group.clauses.length} condition{group.clauses.length !== 1 ? "s" : ""}
          </span>
        </div>
        {canRemove && (
          <button type="button" onClick={onRemove} className="text-xs text-muted-foreground hover:text-destructive transition-colors">
            [remove group]
          </button>
        )}
      </div>
      <div className="space-y-2 pl-2 border-l-2 border-border">
        {group.clauses.map((clause: Clause, idx: number) => (
          <ClauseRow
            key={clause.id}
            clause={clause}
            collection={collection}
            onChange={(c: Clause) => updateClause(idx, c)}
            onRemove={() => removeClause(idx)}
            canRemove={group.clauses.length > 1}
          />
        ))}
      </div>
      <button type="button" onClick={addClause} className="text-xs text-muted-foreground hover:text-primary transition-colors pl-2">
        [+ condition]
      </button>
    </div>
  );
}
