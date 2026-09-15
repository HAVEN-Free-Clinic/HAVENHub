/**
 * The initials placeholder shown wherever a person has no photo.
 *
 * Rendered server-side as an SVG by the photo routes rather than in the client,
 * so <PersonPhoto> needs no fallback branch: it points an <img> at the route and
 * gets either a photo or this, with the same dimensions either way.
 */
import { firstNameOf, type PersonNameParts } from "@/platform/person-name";
import { PHOTO_SIZE } from "./shared";

/** Background hues, spaced around the wheel so adjacent names look distinct. */
const HUES = [210, 340, 150, 30, 265, 190, 95, 15];

/** First letters of two name parts, uppercased. "·" when there are none. */
function lettersOf(first: string, last: string): string {
  return `${first.trim()[0] ?? ""}${last.trim()[0] ?? ""}`.toUpperCase() || "·";
}

/**
 * Initials for a person. "·" when unusable.
 *
 * Given the stored parts, the surname is KNOWN rather than guessed at, so a
 * compound surname initials on its own first letter -- "Javier Ponce Terashima"
 * is JP, where the word split says JT. The first initial follows the preferred
 * name, because this placeholder sits next to the display name and an avatar
 * reading MB beside "Peggy Bia" looks like somebody else's.
 *
 * Given a bare string, it falls back to first word + last word, which is all
 * anyone can do with one.
 */
export function toInitials(person: PersonNameParts | string | null): string {
  if (person !== null && typeof person === "object") {
    return lettersOf(firstNameOf(person), person.lastName);
  }
  const words = (person ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "·";
  return lettersOf(words[0], words.length > 1 ? words[words.length - 1] : "");
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

/**
 * A square SVG placeholder carrying the person's initials.
 *
 * `name` is the display name and is what fixes the background hue, so handing
 * this the parts does not repaint every existing avatar a new colour. `parts`,
 * when the caller holds them, is what the initials are read from instead.
 */
export function initialsSvg(name: string | null, parts?: PersonNameParts): string {
  const initials = escapeXml(toInitials(parts ?? name));
  const hue = hueFor(name ?? "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" viewBox="0 0 ${PHOTO_SIZE} ${PHOTO_SIZE}" role="img"><rect width="${PHOTO_SIZE}" height="${PHOTO_SIZE}" fill="hsl(${hue} 45% 35%)"/><text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(PHOTO_SIZE * 0.4)}" font-weight="600" fill="#ffffff">${initials}</text></svg>`;
}
