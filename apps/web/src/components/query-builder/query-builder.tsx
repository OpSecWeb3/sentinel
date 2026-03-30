"use client";

import { useState, useCallback } from "react";
import type { QueryState, ClauseGroup as ClauseGroupType } from "./types";
import { CollectionSelector } from "./collection-selector";
import { ClauseGroup } from "./clause-group";
import { TimeRangePicker } from "./time-range-picker";
import { AggregationPanel } from "./aggregation-panel";
import { QueryPreview } from "./query-preview";
import { TemplateDrawer } from "./template-drawer";
import { defaultGroup } from "./utils";
import { Button } from "@/components/ui/button";

interface QueryBuilderProps {
  state: QueryState;
  onChange: (state: QueryState) => void;
  onRun: () => void;
  onClear: () => void;
  running: boolean;
}

export function QueryBuilder({ state, onChange, onRun, onClear, running }: QueryBuilderProps) {
  const [showTemplates, setShowTemplates] = useState(false);

  const updateGroup = useCallback((idx: number, group: ClauseGroupType) => {
    const groups = [...state.groups];
    groups[idx] = group;
    onChange({ ...state, groups });
  }, [state, onChange]);

  const removeGroup = useCallback((idx: number) => {
    onChange({ ...state, groups: state.groups.filter((_: ClauseGroupType, i: number) => i !== idx) });
  }, [state, onChange]);

  const addGroup = useCallback(() => {
    onChange({ ...state, groups: [...state.groups, defaultGroup()] });
  }, [state, onChange]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <CollectionSelector value={state.collection} onChange={(collection) => onChange({ ...state, collection, page: 1 })} />
        <button type="button" onClick={() => setShowTemplates(true)} className="text-xs text-muted-foreground hover:text-primary transition-colors font-mono">[templates]</button>
      </div>

      <div className="space-y-3">
        {state.groups.map((group: ClauseGroupType, idx: number) => (
          <ClauseGroup key={group.id} group={group} collection={state.collection} onChange={(g: ClauseGroupType) => updateGroup(idx, g)} onRemove={() => removeGroup(idx)} canRemove={state.groups.length > 1} />
        ))}
        <button type="button" onClick={addGroup} className="text-xs text-muted-foreground hover:text-primary transition-colors font-mono">[+ group]</button>
      </div>

      <TimeRangePicker from={state.timeRange.from} to={state.timeRange.to} onChange={(from, to) => onChange({ ...state, timeRange: { from, to }, page: 1 })} />
      <AggregationPanel aggregation={state.aggregation} collection={state.collection} onChange={(aggregation) => onChange({ ...state, aggregation, page: 1 })} />
      <QueryPreview state={state} />

      <div className="flex items-center gap-3">
        <Button onClick={onRun} disabled={running} className="font-mono text-xs">{running ? "$ running..." : "$ run query"}</Button>
        <button type="button" onClick={onClear} className="text-xs text-muted-foreground hover:text-destructive transition-colors font-mono">[clear]</button>
      </div>

      <TemplateDrawer open={showTemplates} onClose={() => setShowTemplates(false)} onSelect={(s) => onChange({ ...s, page: 1 })} />
    </div>
  );
}
