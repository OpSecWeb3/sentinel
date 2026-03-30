"use client";

import type { QueryOperator } from "./types";
import { Select } from "@/components/ui/select";
import { OPERATORS_BY_TYPE, OPERATOR_LABELS } from "./utils";

interface OperatorSelectProps {
  value: QueryOperator;
  onChange: (op: QueryOperator) => void;
  fieldType?: string;
}

export function OperatorSelect({ value, onChange, fieldType = "string" }: OperatorSelectProps) {
  const ops = OPERATORS_BY_TYPE[fieldType] ?? OPERATORS_BY_TYPE.string;
  const options = ops.map((op) => ({
    value: op,
    label: OPERATOR_LABELS[op],
  }));

  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as QueryOperator)}
      options={options}
      placeholder="op..."
      className="w-32"
    />
  );
}
