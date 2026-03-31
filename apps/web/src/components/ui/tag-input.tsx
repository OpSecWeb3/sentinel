"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** Split stored value into tags (supports legacy comma-only single-line pastes). */
export function splitToTags(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinTags(tags: string[]): string {
  return tags.join("\n");
}

export interface TagInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  invalid?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

export type TagInputHandle = { focus: () => void };

export const TagInput = forwardRef<TagInputHandle, TagInputProps>(
  function TagInput(
    {
      id,
      value,
      onChange,
      placeholder = "add entry…",
      className,
      invalid,
      disabled,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
    },
    ref,
  ) {
    const tags = useMemo(() => splitToTags(value), [value]);
    const [draft, setDraft] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

    const pushTags = useCallback(
      (incoming: string[]) => {
        if (incoming.length === 0) return;
        const seen = new Set(tags.map((t) => t.toLowerCase()));
        const next = [...tags];
        for (const t of incoming) {
          const k = t.toLowerCase();
          if (!seen.has(k)) {
            seen.add(k);
            next.push(t);
          }
        }
        onChange(joinTags(next));
      },
      [tags, onChange],
    );

    const commitDraft = useCallback(() => {
      const t = draft.trim();
      if (!t) return;
      pushTags([t]);
      setDraft("");
    }, [draft, pushTags]);

    const removeAt = useCallback(
      (index: number) => {
        const next = tags.filter((_, i) => i !== index);
        onChange(joinTags(next));
      },
      [tags, onChange],
    );

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        commitDraft();
        return;
      }
      if (e.key === "Backspace" && draft === "" && tags.length > 0) {
        e.preventDefault();
        removeAt(tags.length - 1);
      }
    }

    function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
      const text = e.clipboardData.getData("text");
      if (!text.includes("\n") && !text.includes(",")) return;
      e.preventDefault();
      const parts = splitToTags(text);
      if (parts.length) pushTags(parts);
      setDraft("");
    }

    return (
      <div
        className={cn(
          "flex min-h-10 w-full cursor-text flex-wrap items-center gap-1.5 border-b border-border bg-transparent px-1 py-1.5 font-mono text-xs transition-colors",
          "focus-within:border-primary",
          invalid && "border-destructive focus-within:border-destructive",
          disabled && "pointer-events-none opacity-50",
          className,
        )}
        onClick={() => {
          if (!disabled) inputRef.current?.focus();
        }}
      >
        {tags.map((tag, i) => (
          <Badge
            key={`${tag}-${i}`}
            variant="outline"
            className={cn(
              "pointer-events-auto inline-flex max-w-full items-center gap-1 border-border px-1.5 py-0.5 text-[11px] font-mono text-foreground",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="truncate" title={tag}>
              [{tag}]
            </span>
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(i);
                }}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${tag}`}
              >
                ×
              </button>
            )}
          </Badge>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commitDraft()}
          onClick={(e) => e.stopPropagation()}
          placeholder={tags.length === 0 ? placeholder : ""}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid ?? invalid}
          className="min-w-[8rem] flex-1 border-0 bg-transparent py-0.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
    );
  },
);

TagInput.displayName = "TagInput";
