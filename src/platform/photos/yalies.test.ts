import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `config` is a singleton parsed from process.env at module load (see
// src/platform/config.ts), so vi.stubEnv after that first import never
// reaches it. Mock the module instead with a mutable object, matching the
// pattern in src/modules/passport/services/wallet-client.test.ts. This lets
// individual tests flip YALIES_API_KEY on and off instead of pinning it once
// at module scope, which is required to exercise the no-key branch and
// isYaliesEnabled() at all.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {} as { YALIES_API_KEY?: string },
}));
vi.mock("@/platform/config", () => ({ config: mockConfig }));

import { fetchYaliesPhoto, isYaliesEnabled } from "./yalies";

/** A PNG byte response the image fetch can return. */
function imageResponse(): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

const PHOTO_URL = "https://yalestudentphotos.s3.amazonaws.com/abc.jpg";

describe("fetchYaliesPhoto", () => {
  beforeEach(() => {
    mockConfig.YALIES_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns bytes when Yalies has a photo", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    const bytes = await fetchYaliesPhoto("abc12");

    expect(bytes).toBeInstanceOf(Buffer);
  });

  it("sends the netid filter and a bearer token over https", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    await fetchYaliesPhoto("abc12");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://api.yalies.io/v2/people");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init?.body))).toEqual({ filters: { netid: ["abc12"] } });
  });

  it("returns null when the person has no image", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ netid: "abc12", image: null }]));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("returns null when nobody matches the netid", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([]));

    expect(await fetchYaliesPhoto("nope99")).toBeNull();
  });

  it("returns null when the API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 500 }));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("returns null when the API is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("returns null when the image object is gone", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("refuses an image URL on an unexpected host", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json([{ netid: "abc12", image: "http://169.254.169.254/latest/meta-data/" }])
    );

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("refuses a response that is not an image", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(
        new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })
      );

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
  });

  it("returns null and never calls fetch when no API key is configured", async () => {
    mockConfig.YALIES_API_KEY = undefined;

    expect(await fetchYaliesPhoto("abc12")).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(0);
  });

  it("does not follow a redirect on the image fetch", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        })
      );

    expect(await fetchYaliesPhoto("abc12")).toBeNull();

    const [, imageInit] = vi.mocked(fetch).mock.calls[1];
    expect(imageInit?.redirect).toBe("manual");
  });

  it("bounds both fetch calls with one shared timeout signal, not one each", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    await fetchYaliesPhoto("abc12");

    const [, lookupInit] = vi.mocked(fetch).mock.calls[0];
    const [, imageInit] = vi.mocked(fetch).mock.calls[1];
    expect(lookupInit?.signal).toBeInstanceOf(AbortSignal);
    expect(imageInit?.signal).toBeInstanceOf(AbortSignal);
    expect(imageInit?.signal).toBe(lookupInit?.signal);
  });
});

describe("isYaliesEnabled", () => {
  it("returns true when an API key is configured", () => {
    mockConfig.YALIES_API_KEY = "test-key";

    expect(isYaliesEnabled()).toBe(true);
  });

  it("returns false when no API key is configured", () => {
    mockConfig.YALIES_API_KEY = undefined;

    expect(isYaliesEnabled()).toBe(false);
  });
});
