import { useEffect, useState } from "react";

/** Reactive CSS media-query match — re-renders when the query flips. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** True on the narrow (phone) layout, where the sidebar is icon-only. */
export const MOBILE_QUERY = "(max-width: 860px)";
