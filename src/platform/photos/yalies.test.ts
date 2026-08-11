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

import { log } from "@/platform/logging";
import { fetchYaliesPhoto, isPersonSpecificMiss, isYaliesEnabled } from "./yalies";

/** A PNG byte response the image fetch can return. */
function imageResponse(length?: number): Response {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const headers: Record<string, string> = { "content-type": "image/png" };
  if (length !== undefined) headers["content-length"] = String(length);
  return new Response(bytes, { status: 200, headers });
}

const PHOTO_URL = "https://storage.googleapis.com/yalies-photos/541171.jpg";

/** Generous enough that none of the small fixtures above trip it by accident. */
const MAX_BYTES = 4 * 1024 * 1024;

describe("fetchYaliesPhoto", () => {
  beforeEach(() => {
    mockConfig.YALIES_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.spyOn(log, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns bytes when Yalies has a photo", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    const result = await fetchYaliesPhoto("abc12", MAX_BYTES);

    expect(result).toEqual({ bytes: expect.any(Buffer) });
  });

  it("logs an info record with the byte count on success", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    await fetchYaliesPhoto("abc12", MAX_BYTES);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      "[yalies] photo fetched",
      expect.objectContaining({ bytes: expect.any(Number) })
    );
  });

  it("never logs the netId or the API key on success", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    await fetchYaliesPhoto("abc12", MAX_BYTES);

    const allCalls = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain("abc12");
    expect(serialized).not.toContain("test-key");
  });

  it("sends the netid filter and a bearer token over https", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    await fetchYaliesPhoto("abc12", MAX_BYTES);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://api.yalies.io/v2/people");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init?.body))).toEqual({ filters: { netid: ["abc12"] } });
  });

  it("misses and logs 'no_image' when the person has no image", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ netid: "abc12", image: null }]));

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "no_image" })
    );
  });

  it("misses and logs 'no_match' when nobody matches the netid", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([]));

    expect(await fetchYaliesPhoto("nope99", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "no_match" })
    );
  });

  it("misses and logs 'lookup_not_ok' when the API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("nope", { status: 500 }));

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "lookup_not_ok", status: 500 })
    );
  });

  it("misses and logs 'exception' when the API is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "exception", "error.message": "ECONNREFUSED" })
    );
  });

  it("misses and logs 'image_not_ok' when the image object is gone", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "image_not_ok", status: 404 })
    );
  });

  it("refuses a non-https image URL and logs 'bad_protocol'", async () => {
    // The cloud metadata endpoint is the canonical server-side request forgery
    // target. It must be refused before the image fetch is ever issued.
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json([{ netid: "abc12", image: "http://169.254.169.254/latest/meta-data/" }])
    );

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "bad_protocol", host: "169.254.169.254" })
    );
  });

  it("refuses an https image URL on an unexpected host and logs the host it saw", async () => {
    // The logged host is the point of this test, not a nicety: a drifted image
    // host is the likeliest cause of a total miss stream, and the log is the
    // only place the new value can be learned without querying the API by hand.
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json([{ netid: "abc12", image: "https://cdn.example.com/photos/abc12.jpg" }])
    );

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "bad_host", host: "cdn.example.com" })
    );
  });

  it("refuses a different bucket on the allowed Google Cloud Storage host", async () => {
    // storage.googleapis.com is shared by every GCS bucket on the internet, so
    // the hostname alone is not a boundary. Without the bucket-path pin this
    // URL would be fetched, and this test is the only thing that says so.
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json([
        { netid: "abc12", image: "https://storage.googleapis.com/somebody-else/x.jpg" },
      ])
    );

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "bad_host", bucket: "/somebody-else/" })
    );
  });

  it("still accepts the legacy S3 host, so a reverted migration keeps working", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json([
          { netid: "abc12", image: "https://yalestudentphotos.s3.amazonaws.com/abc.jpg" },
        ])
      )
      .mockResolvedValueOnce(imageResponse());

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toEqual({ bytes: expect.any(Buffer) });
  });

  it("refuses an unparseable image value and logs 'unparseable_url'", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json([{ netid: "abc12", image: "not a url at all" }])
    );

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "unparseable_url" })
    );
  });

  it("refuses a response that is not an image and logs 'not_an_image'", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(
        new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })
      );

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "not_an_image" })
    );
  });

  it("returns null, logs 'no_api_key', and never calls fetch when no API key is configured", async () => {
    mockConfig.YALIES_API_KEY = undefined;

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(0);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "no_api_key" })
    );
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

    expect(await fetchYaliesPhoto("abc12", MAX_BYTES)).toHaveProperty("miss");

    const [, imageInit] = vi.mocked(fetch).mock.calls[1];
    expect(imageInit?.redirect).toBe("manual");
  });

  it("bounds both fetch calls with one shared timeout signal, not one each", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse());

    await fetchYaliesPhoto("abc12", MAX_BYTES);

    const [, lookupInit] = vi.mocked(fetch).mock.calls[0];
    const [, imageInit] = vi.mocked(fetch).mock.calls[1];
    expect(lookupInit?.signal).toBeInstanceOf(AbortSignal);
    expect(imageInit?.signal).toBeInstanceOf(AbortSignal);
    expect(imageInit?.signal).toBe(lookupInit?.signal);
  });

  it("treats a response whose declared content-length exceeds maxBytes as a miss, without buffering it", async () => {
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png", "content-length": "1000" }),
        arrayBuffer: arrayBufferSpy,
      } as unknown as Response);

    expect(await fetchYaliesPhoto("abc12", 100)).toHaveProperty("miss");
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "too_large", bytes: 1000 })
    );
  });

  it("treats actual bytes over the limit as a miss even when content-length is absent or lied about", async () => {
    // No content-length header at all: the declared-length fast path cannot
    // catch this, so the real buffer length is the only thing that can.
    const oversizedBody = new Uint8Array(200);
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(new Response(oversizedBody, { status: 200, headers: { "content-type": "image/png" } }));

    expect(await fetchYaliesPhoto("abc12", 100)).toHaveProperty("miss");
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "[yalies] photo miss",
      expect.objectContaining({ reason: "too_large" })
    );
  });

  it("accepts an image at exactly the byte limit", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ netid: "abc12", image: PHOTO_URL }]))
      .mockResolvedValueOnce(imageResponse(4));

    expect(await fetchYaliesPhoto("abc12", 4)).toEqual({ bytes: expect.any(Buffer) });
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

describe("isPersonSpecificMiss", () => {
  // This classifier decides whether a failed pull advances a person's backoff
  // toward 30 days. Getting it wrong in the permissive direction is what let a
  // single upstream host change silence every Yale College member for a day
  // after the integration was already healthy again.
  it("treats only no_match and no_image as facts about the person", () => {
    expect(isPersonSpecificMiss("no_match")).toBe(true);
    expect(isPersonSpecificMiss("no_image")).toBe(true);
  });

  it("treats every integration failure as saying nothing about the person", () => {
    for (const reason of [
      "no_api_key",
      "lookup_not_ok",
      "exception",
      "unparseable_url",
      "bad_protocol",
      "bad_host",
      "image_not_ok",
      "not_an_image",
      "too_large",
    ] as const) {
      expect(isPersonSpecificMiss(reason)).toBe(false);
    }
  });
});
