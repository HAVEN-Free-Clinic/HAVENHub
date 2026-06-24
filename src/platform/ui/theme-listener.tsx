"use client";

import { useEffect } from "react";
import { THEME_ATTR } from "./theme";

/** When the active preference is "system", track live OS color-scheme changes. */
export function ThemeListener() {
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    function sync() {
      if (document.documentElement.getAttribute(THEME_ATTR) === "system") {
        document.documentElement.classList.toggle("dark", mql.matches);
      }
    }
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);
  return null;
}
