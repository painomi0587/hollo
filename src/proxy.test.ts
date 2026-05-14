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

describe.sequential("proxy route", () => {
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

  it("returns 404 from an off-mode app", async () => {
    expect.assertions(2);

    const app = createProxyApp("off");
    const { sig, b64url } = signProxyUrl("https://example.com/a.png");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the signature is invalid", async () => {
    expect.assertions(2);

    const app = createProxyApp("proxy");
    const { b64url } = signProxyUrl("https://example.com/a.png");
    const tampered = "AAAAAAAAAAAAAAAAAAAAAA";

    const response = await app.request(`/${tampered}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the URL would fail SSRF protection", async () => {
    expect.assertions(2);

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("http://127.0.0.1:9999/secret");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the upstream body and preserves Content-Type in proxy mode", async () => {
    expect.assertions(5);

    const png = new Uint8Array([1, 2, 3, 4]);
    fetchMock.mockResolvedValue(
      buildResponse(png, { contentType: "image/png" }),
    );

    const app = createProxyApp("proxy");
    const url = "https://remote.example/a.png";
    const { sig, b64url } = signProxyUrl(url);

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.any(Object));
  });

  it("refuses to proxy image/svg+xml to avoid same-origin XSS", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      buildResponse("<svg/>", { contentType: "image/svg+xml" }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/x.svg");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("re-runs SSRF checks on redirect targets", async () => {
    expect.assertions(2);

    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:9999/secret" },
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://public.example/img");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows safe redirects up to the configured limit", async () => {
    expect.assertions(3);

    const png = new Uint8Array([7, 7, 7]);
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "https://hop2.example/img" },
        }),
      )
      .mockResolvedValueOnce(buildResponse(png, { contentType: "image/png" }));

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://hop1.example/img");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects responses whose Content-Type is not in the allowlist", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      buildResponse("nope", { contentType: "text/html" }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/page.html");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("propagates failed upstream status as 404", async () => {
    expect.assertions(1);

    fetchMock.mockResolvedValue(
      new Response("gone", {
        status: 410,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const app = createProxyApp("proxy");
    const { sig, b64url } = signProxyUrl("https://remote.example/missing.png");

    const response = await app.request(`/${sig}/${b64url}`);

    expect(response.status).toBe(404);
  });

  it("writes the cache on first hit and reuses it on the second in cache mode", async () => {
    expect.assertions(4);

    const png = new Uint8Array([9, 8, 7, 6, 5]);
    fetchMock.mockResolvedValue(
      buildResponse(png, { contentType: "image/png" }),
    );

    const app = createProxyApp("cache");
    const url = "https://remote.example/c.png";
    const { sig, b64url } = signProxyUrl(url);

    const first = await app.request(`/${sig}/${b64url}`);
    const second = await app.request(`/${sig}/${b64url}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
