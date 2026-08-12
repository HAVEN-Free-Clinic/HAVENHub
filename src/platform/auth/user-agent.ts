/**
 * Turns a stored user agent string into something an admin can read, like
 * "Safari 18 on iPhone".
 *
 * Parsing happens here, at display time, rather than at capture: user agent
 * strings change constantly, so a wrong answer is then a display bug fixable
 * later against data already collected, instead of data lost at write time.
 *
 * Deliberately small. This exists to help someone triaging a support ticket,
 * not to be a general-purpose UA database, so it covers the browsers this app
 * actually sees and falls back to the raw string for everything else.
 */

/** Order matters: Edge and Chrome both contain "Chrome", so Edge is tested first. */
const BROWSERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "Edge", pattern: /Edg\/(\d+)/ },
  { name: "Firefox", pattern: /Firefox\/(\d+)/ },
  { name: "Chrome", pattern: /Chrome\/(\d+)/ },
  // Safari reports its release in Version/, not in the Safari/ token, which
  // carries a WebKit build number instead.
  { name: "Safari", pattern: /Version\/(\d+).*Safari\// },
];

/** Order matters: iPhone and iPad are also "Mac OS X", so they are tested first. */
const PLATFORMS: Array<{ name: string; pattern: RegExp }> = [
  { name: "iPhone", pattern: /iPhone/ },
  { name: "iPad", pattern: /iPad/ },
  { name: "Android", pattern: /Android/ },
  { name: "Windows", pattern: /Windows NT/ },
  { name: "macOS", pattern: /Macintosh|Mac OS X/ },
  { name: "Linux", pattern: /Linux/ },
];

export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua || ua.trim() === "") return null;

  const browser = BROWSERS.find((b) => b.pattern.test(ua));
  const platform = PLATFORMS.find((p) => p.pattern.test(ua));
  if (!browser || !platform) return ua;

  const version = ua.match(browser.pattern)?.[1];
  if (!version) return ua;

  return `${browser.name} ${version} on ${platform.name}`;
}
