import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { signProxyUrl } from "./media-proxy";
import { createProxyApp } from "./proxy";
import { prefetchProxyCacheForMode, proxyCacheKeyForUrl } from "./proxy-cache";
import { drive } from "./storage";

function buildResponse(
  body: Uint8Array | string,
  options: { status?: number; contentType?: string } = {},
): Response {
  const status = options.status ?? 200;
  const contentType = options.contentType ?? "image/png";
  const init: BodyInit =
    typeof body === "string" ? body : (body.buffer as ArrayBuffer);
  return new Response(init, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe.sequential("proxy cache prefetch", () => {
  let fetchMock: MockInstance<typeof fetch>;

  beforeEach(() => {
    drive.fake();
    fetchMock = vi.spyOn(globalThis, "fetch") as unknown as MockInstance<
      typeof fetch
    >;
    fetchMock.mockReset();
  });

  afterEach(() => {
    drive.restore();
    fetchMock.mockRestore();
  });

  it("prefetches into the same cache entry served by the proxy route", async () => {
    expect.assertions(6);

    const avatar = new Uint8Array([1, 3, 5, 7]);
    fetchMock.mockResolvedValue(
      buildResponse(avatar, { contentType: "image/webp" }),
    );

    const url = "https://remote.example/avatar.webp";
    const prefetched = await prefetchProxyCacheForMode("cache", url);
    const disk = drive.use();
    const key = proxyCacheKeyForUrl(url);

    expect(prefetched).toBe(true);
    expect(await disk.exists(`${key}.bin`)).toBe(true);
    expect(await disk.exists(`${key}.json`)).toBe(true);

    const app = createProxyApp("cache");
    const { sig, b64url } = signProxyUrl(url);
    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(avatar);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when the cache entry already exists", async () => {
    expect.assertions(3);

    const avatar = new Uint8Array([2, 4, 6, 8]);
    fetchMock.mockResolvedValueOnce(
      buildResponse(avatar, { contentType: "image/png" }),
    );

    const url = "https://remote.example/already.png";
    await expect(prefetchProxyCacheForMode("cache", url)).resolves.toBe(true);
    await expect(prefetchProxyCacheForMode("cache", url)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op outside cache mode", async () => {
    expect.assertions(3);

    const url = "https://remote.example/no-cache.png";

    await expect(prefetchProxyCacheForMode("off", url)).resolves.toBe(false);
    await expect(prefetchProxyCacheForMode("proxy", url)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache unsafe or unsupported responses", async () => {
    expect.assertions(4);

    await expect(
      prefetchProxyCacheForMode("cache", "http://127.0.0.1/avatar.png"),
    ).resolves.toBe(false);

    fetchMock.mockResolvedValue(
      buildResponse("<svg/>", { contentType: "image/svg+xml" }),
    );

    const svgUrl = "https://remote.example/avatar.svg";
    await expect(prefetchProxyCacheForMode("cache", svgUrl)).resolves.toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await drive.use().exists(`${proxyCacheKeyForUrl(svgUrl)}.bin`)).toBe(
      false,
    );
  });
});
