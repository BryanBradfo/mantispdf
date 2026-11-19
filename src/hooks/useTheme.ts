import { useEffect, useState } from "react";

/** The stored choice; null when there is none or storage is unavailable (private mode, blocked site data). */
function readStoredTheme(): string | null {
  try {
    return localStorage.getItem("theme");
  } catch {
    return null;
  }
}

/** Dark unless the user explicitly stored "light" (the system preference is ignored on purpose). */
export function useTheme() {
  const [dark, setDark] = useState<boolean>(() => readStoredTheme() !== "light");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      // Storage unavailable: the choice holds for this page view only.
    }
  }, [dark]);

  return [dark, setDark] as const;
}
