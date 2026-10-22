import { useRef } from "react";

/**
 * A ref that always holds the latest `value`. For callbacks built once (an upload queue) that must
 * still read the current translation: depending on `t` would rebuild them on a language switch
 * and cancel the work in flight.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
