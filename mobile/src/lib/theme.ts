import { useColorScheme } from "react-native";

/** The Hub's own tokens (src/app/globals.css in the web app), light and dark. */
const light = {
  brand: "#00356b",
  brandFaint: "#f0f5fb",
  onBrand: "#ffffff",
  background: "#f8fafc",
  surface: "#ffffff",
  foreground: "#0f172a",
  foregroundSoft: "#334155",
  mutedForeground: "#526076",
  border: "#e2e8f0",
  success: "#15743a",
  danger: "#b91c1c",
  warningBg: "#fef3c7",
  warningFg: "#92400e",
};

const dark: typeof light = {
  brand: "#7f9ab5",
  brandFaint: "#0b1b30",
  onBrand: "#0b1220",
  background: "#0b1220",
  surface: "#0f172a",
  foreground: "#f1f5f9",
  foregroundSoft: "#cbd5e1",
  mutedForeground: "#94a3b8",
  border: "#334155",
  success: "#4ade80",
  danger: "#f87171",
  warningBg: "#422006",
  warningFg: "#fcd34d",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
