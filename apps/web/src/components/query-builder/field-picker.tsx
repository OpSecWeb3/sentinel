"use client";

import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import type { Collection } from "./types";
import { EVENT_COLUMNS, ALERT_COLUMNS } from "./types";

interface FieldPickerProps {
  collection: Collection;
  value: string;
  onChange: (field: string) => void;
}

function buildOptions(collection: Collection): ComboboxOption[] {
  const cols = collection === "events" ? EVENT_COLUMNS : ALERT_COLUMNS;
  const topLevel = cols.map((c: string) => ({
    value: c,
    label: c,
    description: "column",
  }));

  const payloadFields: ComboboxOption[] =
    collection === "events"
      ? [
          { value: "payload.sender.login", label: "sender.login", description: "payload · GitHub sender username" },
          { value: "payload.repository.full_name", label: "repository.full_name", description: "payload · GitHub repo name" },
          { value: "payload.action", label: "action", description: "payload · event action" },
          { value: "payload.errorCode", label: "errorCode", description: "payload · AWS error code" },
          { value: "payload.sourceIPAddress", label: "sourceIPAddress", description: "payload · AWS source IP" },
          { value: "payload.eventName", label: "eventName", description: "payload · AWS event name" },
          { value: "payload.contractAddress", label: "contractAddress", description: "payload · chain contract" },
          { value: "payload.transactionHash", label: "transactionHash", description: "payload · chain tx hash" },
          { value: "payload.resourceId", label: "resourceId", description: "payload · resource identifier" },
          { value: "payload.hostname", label: "hostname", description: "payload · infra hostname" },
          { value: "payload.artifact", label: "artifact", description: "payload · registry artifact" },
        ]
      : [
          { value: "triggerData.ruleType", label: "ruleType", description: "trigger data · rule type" },
          { value: "triggerData.module", label: "module", description: "trigger data · source module" },
          { value: "triggerData.correlationType", label: "correlationType", description: "trigger data · correlation type" },
        ];

  return [...topLevel, ...payloadFields];
}

export function FieldPicker({ collection, value, onChange }: FieldPickerProps) {
  const options = buildOptions(collection);
  return (
    <Combobox
      value={value}
      onValueChange={onChange}
      options={options}
      placeholder="field..."
      searchPlaceholder="search fields..."
      className="w-48"
    />
  );
}
