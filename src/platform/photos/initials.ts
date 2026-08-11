/**
 * The initials placeholder shown wherever a person has no photo.
 *
 * Rendered server-side as an SVG by the photo routes rather than in the client,
 * so <PersonPhoto> needs no fallback branch: it points an <img> at the route and
 * gets either a photo or this, with the same dimensions either way.
 */
import { PHOTO_SIZE } from "./shared";

/** Background hues, spaced around the wheel so adjacent names look distinct. */
const HUES = [210, 340, 150, 30, 265, 190, 95, 15];

/** Initials for a name: first and last word, uppercased. "·" when unusable. */
export function toInitials(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "·";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}

/** Stable hue for a name, so a person's placeholder never changes colour. */
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100000;
  }
  return HUES[hash % HUES.length];
}

/** Escape the five XML metacharacters so a name cannot break out of the markup. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A square SVG placeholder carrying the person's initials. */
export function initialsSvg(name: string | null): string {
  const initials = escapeXml(toInitials(name));
  const hue = hueFor(name ?? "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" viewBox="0 0 ${PHOTO_SIZE} ${PHOTO_SIZE}" role="img"><rect width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" fill="hsl(${hue} 45% 35%)"/><text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(PHOTO_SIZE * 0.4)}" font-weight="600" fill="#ffffff">${initials}</text></svg>`;
}
