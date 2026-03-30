"use client";

import type { Clause, Collection } from "./types";
import { FieldPicker } from "./field-picker";
import { OperatorSelect } from "./operator-select";
import { ValueInput } from "./value-input";

interface ClauseRowProps {
  clause: Clause;
  collection: Collection;
  onChange: (updated: Clause) => void;
  onRemove: () => void;
  canRemove: boolean;
}

export function ClauseRow({ clause, collection, onChange, onRemove, canRemove }: ClauseRowProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <FieldPicker
        collection={collection}
        value={clause.field}
        onChange={(field) => onChange({ ...clause, field })}
      />
      <OperatorSelect
        value={clause.operator}
        onChange={(operator) => onChange({ ...clause, operator })}
      />
      <ValueInput
        operator={clause.operator}
        value={clause.value}
        onChange={(value) => onChange({ ...clause, value })}
      />
      {canRemove && (
        <button type="button" onClick={onRemove} className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0">
          [x]
        </button>
      )}
    </div>
  );
}
