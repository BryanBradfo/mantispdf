import { useLayoutEffect, useRef } from "react";

/**
 * A ref that holds the latest `value` (updated after each commit, before any effect or event
 * handler runs). For callbacks built once (an upload queue) that must still read the current
 * translation: depending on `t` would rebuild them on a language switch and cancel the work in flight.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
