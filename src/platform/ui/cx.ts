/** Join truthy class-name parts with a space. The one canonical classname helper. */
export function cx(...parts: (string | undefined | false | null)[]): string {
  return parts.filter(Boolean).join(" ");
}
