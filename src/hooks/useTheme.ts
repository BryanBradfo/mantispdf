import { useEffect, useState } from "react";

/** Dark unless the user explicitly stored "light" (the system preference is ignored on purpose). */
export function useTheme() {
  const [dark, setDark] = useState<boolean>(() => localStorage.getItem("theme") !== "light");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  return [dark, setDark] as const;
}
