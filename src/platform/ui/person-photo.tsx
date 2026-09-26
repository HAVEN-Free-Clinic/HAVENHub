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
  /**
   * Beside a visible name the photo adds nothing for a screen reader, and an alt
   * of the same name would announce it twice. Pass "" there.
   */
  alt?: string;
};

export function PersonPhoto({ person, size, className, alt }: PersonPhotoProps) {
  return (
    <img
      src={photoUrl(person)}
      alt={alt ?? person.name ?? "Member"}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={className ?? "rounded-full object-cover"}
      style={{ width: size, height: size }}
    />
  );
}
