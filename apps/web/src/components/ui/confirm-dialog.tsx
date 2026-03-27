"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

interface ConfirmState {
  open: boolean;
  title: string;
  description: string;
  variant?: "destructive" | "default";
  confirmLabel?: string;
  cancelLabel?: string;
  resolve: ((confirmed: boolean) => void) | null;
}

interface ConfirmOptions {
  variant?: "destructive" | "default";
  confirmLabel?: string;
  cancelLabel?: string;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState>({
    open: false,
    title: "",
    description: "",
    resolve: null,
  });

  const confirm = useCallback(
    (
      title: string,
      description: string,
      options?: ConfirmOptions,
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        setState({
          open: true,
          title,
          description,
          variant: options?.variant ?? "destructive",
          confirmLabel: options?.confirmLabel,
          cancelLabel: options?.cancelLabel,
          resolve,
        });
      });
    },
    [],
  );

  const handleClose = useCallback(
    (confirmed: boolean) => {
      state.resolve?.(confirmed);
      setState({
        open: false,
        title: "",
        description: "",
        resolve: null,
      });
    },
    [state.resolve],
  );

  return { confirmState: state, confirm, handleClose };
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  variant?: "destructive" | "default";
  confirmLabel?: string;
  cancelLabel?: string;
  onClose: (confirmed: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  variant = "destructive",
  confirmLabel,
  cancelLabel,
  onClose,
}: ConfirmDialogProps) {
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  // Animate in
  useEffect(() => {
    if (open) {
      setVisible(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimating(true));
      });
    } else {
      setAnimating(false);
      const timer = setTimeout(() => setVisible(false), 150);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Focus trap + escape
  useEffect(() => {
    if (!open) return;
    confirmBtnRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose(false);
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className={cn(
          "absolute inset-0 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
          animating ? "opacity-100" : "opacity-0",
        )}
        onClick={() => onClose(false)}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
        className={cn(
          "relative z-10 w-full max-w-md rounded-lg border bg-card p-6 shadow-lg shadow-black/20 font-mono transition-all duration-150",
          variant === "destructive"
            ? "border-destructive/30"
            : "border-border",
          animating
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 translate-y-2",
        )}
      >
        <div className="flex items-start gap-3">
          {variant === "destructive" && (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2
              id="confirm-title"
              className={cn(
                "text-sm font-bold",
                variant === "destructive"
                  ? "text-destructive"
                  : "text-primary",
              )}
            >
              {title}
            </h2>
            <p
              id="confirm-desc"
              className="mt-2 text-sm text-muted-foreground leading-relaxed"
            >
              {description}
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onClose(false)}
          >
            {cancelLabel ?? "Cancel"}
          </Button>
          <Button
            ref={confirmBtnRef}
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={() => onClose(true)}
          >
            {confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
