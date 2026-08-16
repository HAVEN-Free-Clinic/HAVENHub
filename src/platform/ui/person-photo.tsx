/**
 * A person's photo, or their initials when they have none.
 *
 * There is deliberately no fallback branch here. The photo route serves an
 * initials SVG when a person has no photo, so this <img> always resolves to
 * something with the right dimensions and the component stays a one-liner.
 */
import { photoUrl } from "@/platform/photos/shared";

type PersonPhotoProps = {
  person: { id: string; name: string | null; photoVersion: number };
  /** Rendered edge length in pixels. */
  size: number;
  className?: string;
};

export function PersonPhoto({ person, size, className }: PersonPhotoProps) {
  return (
    <img
      src={photoUrl(person)}
      alt={person.name ?? "Member"}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={className ?? "rounded-full object-cover"}
      style={{ width: size, height: size }}
    />
  );
}
