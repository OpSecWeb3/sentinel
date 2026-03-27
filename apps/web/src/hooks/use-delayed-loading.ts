import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Prevents jarring loading UI flashes for fast responses and ensures
 * minimum display time when loading IS shown.
 *
 * - `delay` (default 150ms): don't show loading UI until this time elapses
 * - `minDisplay` (default 300ms): once shown, keep loading visible at least this long
 *
 * Returns `showLoading` which is true only when the spinner/skeleton
 * should actually be rendered.
 */
export function useDelayedLoading(
  isLoading: boolean,
  { delay = 150, minDisplay = 300 } = {},
): boolean {
  const [showLoading, setShowLoading] = useState(false);
  const showTimestamp = useRef<number | null>(null);
  const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isLoading) {
      // Start delay timer — only show loading after `delay` ms
      delayTimer.current = setTimeout(() => {
        showTimestamp.current = Date.now();
        setShowLoading(true);
      }, delay);
    } else {
      // Loading finished — clear any pending delay
      if (delayTimer.current) {
        clearTimeout(delayTimer.current);
        delayTimer.current = null;
      }

      // If loading UI was shown, ensure minimum display time
      if (showTimestamp.current !== null) {
        const elapsed = Date.now() - showTimestamp.current;
        const remaining = Math.max(0, minDisplay - elapsed);

        if (remaining > 0) {
          hideTimer.current = setTimeout(() => {
            setShowLoading(false);
            showTimestamp.current = null;
          }, remaining);
        } else {
          setShowLoading(false);
          showTimestamp.current = null;
        }
      } else {
        setShowLoading(false);
      }
    }

    return () => {
      if (delayTimer.current) clearTimeout(delayTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [isLoading, delay, minDisplay]);

  return showLoading;
}

/**
 * Wraps an async fetch call so it returns data, a raw `loading` boolean,
 * and a `showLoading` boolean that uses the delayed pattern.
 */
export function useDelayedFetch<T>(
  fetchFn: () => Promise<T>,
  deps: unknown[],
  { delay = 150, minDisplay = 300 } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const showLoading = useDelayedLoading(loading, { delay, minDisplay });

  const execute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    execute();
  }, [execute]);

  return { data, loading, showLoading, error, refetch: execute };
}
