"use client";

import { useState, useTransition } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { THEME_ATTR, THEME_COOKIE, effectiveClass, type ThemePreference } from "./theme";
import { setThemePreference } from "./theme-actions";

const NEXT: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const LABEL = { light: "Light", dark: "Dark", system: "System" } as const;

function applyToDocument(pref: ThemePreference) {
  const root = document.documentElement;
  root.setAttribute(THEME_ATTR, pref);
  // Live OS-scheme changes while in "system" mode are handled separately by ThemeListener.
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("dark", effectiveClass(pref, prefersDark) === "dark");
  document.cookie = `${THEME_COOKIE}=${pref};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
}

export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [pref, setPref] = useState<ThemePreference>(initial);
  const [, startTransition] = useTransition();
  const Icon = ICON[pref];

  function cycle() {
    const next = NEXT[pref];
    setPref(next);
    applyToDocument(next); // optimistic, instant
    startTransition(() => {
      void setThemePreference(next);
    });
  }

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Current theme: ${LABEL[pref]}. Activate to switch to ${LABEL[NEXT[pref]]}.`}
      title={`Theme: ${LABEL[pref]}`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <Icon aria-hidden className="h-4 w-4" />
    </button>
  );
}
