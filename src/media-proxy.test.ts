import { describe, expect, it } from "vitest";

import {
  parseMediaProxyMode,
  parseRemoteMediaThumbnails,
  proxyUrlForMode,
  signProxyUrl,
  verifyProxySignature,
} from "./media-proxy";

describe("media-proxy", () => {
  describe("signProxyUrl / verifyProxySignature", () => {
    it("round-trips a URL", () => {
      expect.assertions(1);
      const original = "https://example.com/avatar.png";
      const { sig, b64url } = signProxyUrl(original);
      expect(verifyProxySignature(sig, b64url)).toBe(original);
    });

    it("rejects a tampered signature", () => {
      expect.assertions(1);
      const { sig, b64url } = signProxyUrl("https://example.com/a.png");
      // Flip the first byte; trailing base64url chars can carry unused
      // padding bits that survive decoding, so they're an unreliable target.
      const first = sig.charAt(0);
      const tampered = (first === "A" ? "B" : "A") + sig.slice(1);
      expect(verifyProxySignature(tampered, b64url)).toBeNull();
    });

    it("rejects a signature from a different payload", () => {
      expect.assertions(1);
      const a = signProxyUrl("https://example.com/a.png");
      const b = signProxyUrl("https://example.com/b.png");
      expect(verifyProxySignature(a.sig, b.b64url)).toBeNull();
    });

    it("rejects non-base64url input", () => {
      expect.assertions(2);
      const { b64url } = signProxyUrl("https://example.com/a.png");
      expect(verifyProxySignature("!!!", b64url)).toBeNull();
      expect(verifyProxySignature("", b64url)).toBeNull();
    });

    it("preserves UTF-8 characters in the original URL", () => {
      expect.assertions(1);
      const original = "https://example.com/사진.png";
      const { sig, b64url } = signProxyUrl(original);
      expect(verifyProxySignature(sig, b64url)).toBe(original);
    });
  });

  describe("proxyUrlForMode", () => {
    const baseUrl = new URL("http://hollo.test/");

    it("returns null when input is null or undefined", () => {
      expect.assertions(2);
      expect(proxyUrlForMode("proxy", null, baseUrl)).toBeNull();
      expect(proxyUrlForMode("cache", undefined, baseUrl)).toBeNull();
    });

    it("passes the URL through in off mode", () => {
      expect.assertions(2);
      const remote = "https://remote.example/a.png";
      expect(proxyUrlForMode("off", remote, baseUrl)).toBe(remote);
      expect(proxyUrlForMode("off", null, baseUrl)).toBeNull();
    });

    it("does not proxy a URL under the FS storage /assets/ namespace", () => {
      expect.assertions(1);
      // .env.test sets DRIVE_DISK=fs and STORAGE_URL_BASE=http://hollo.test/,
      // so the FS driver serves uploads at http://hollo.test/assets/*.
      const otherBase = new URL("https://app.example/");
      const local = "http://hollo.test/assets/emojis/x.webp";
      expect(proxyUrlForMode("proxy", local, otherBase)).toBe(local);
    });

    it("proxies same-origin URLs outside the storage namespace", () => {
      expect.assertions(2);
      // /admin/... is on the Hollo origin but not under /assets/ — it must
      // NOT be trusted, otherwise an attacker-crafted avatarUrl could ride
      // the operator's session.
      const proxied = proxyUrlForMode(
        "proxy",
        "http://hollo.test/admin/destructive.png",
        baseUrl,
      );
      expect(proxied).not.toBe("http://hollo.test/admin/destructive.png");
      expect(new URL(proxied!).pathname.startsWith("/proxy/")).toBe(true);
    });

    it("rejects dot-segment traversal that would escape the storage prefix", () => {
      expect.assertions(2);
      // The raw string starts with /assets/, but the parsed URL normalizes
      // to /admin/secret.png which is NOT under the trusted namespace.
      const sneaky = "http://hollo.test/assets/../admin/secret.png";
      const proxied = proxyUrlForMode("proxy", sneaky, baseUrl);
      expect(proxied).not.toBe(sneaky);
      expect(new URL(proxied!).pathname.startsWith("/proxy/")).toBe(true);
    });

    it("does not re-proxy a URL that is already a proxy URL", () => {
      expect.assertions(1);
      const remote = "https://remote.example/a.png";
      const proxied = proxyUrlForMode("proxy", remote, baseUrl);
      // Feeding the proxy URL back in should leave it as-is rather than
      // double-wrapping it.
      expect(proxyUrlForMode("proxy", proxied, baseUrl)).toBe(proxied);
    });

    it("rewrites a remote URL through the proxy in proxy mode", () => {
      expect.assertions(3);
      const remote = "https://remote.example/a.png";
      const proxied = proxyUrlForMode("proxy", remote, baseUrl);
      expect(proxied).not.toBeNull();
      const parsed = new URL(proxied!);
      expect(parsed.origin).toBe("http://hollo.test");
      expect(parsed.pathname.startsWith("/proxy/")).toBe(true);
    });

    it("yields a verifiable signature in cache mode", () => {
      expect.assertions(1);
      const remote = "https://remote.example/b.png";
      const proxied = proxyUrlForMode("cache", remote, baseUrl);
      const parts = new URL(proxied!).pathname.split("/");
      // pathname is /proxy/<sig>/<b64url>
      const sig = parts[2];
      const b64url = parts[3];
      expect(verifyProxySignature(sig, b64url)).toBe(remote);
    });

    it("treats non-URL strings as local (no rewrite)", () => {
      expect.assertions(1);
      expect(proxyUrlForMode("proxy", "not-a-url", baseUrl)).toBe("not-a-url");
    });

    it("refuses to proxy non-http(s) schemes", () => {
      expect.assertions(3);
      expect(
        proxyUrlForMode("proxy", "data:image/png;base64,iVBORw0KGgo=", baseUrl),
      ).toBeNull();
      expect(
        proxyUrlForMode("proxy", "javascript:alert(1)", baseUrl),
      ).toBeNull();
      expect(
        proxyUrlForMode("cache", "ftp://example.com/x.png", baseUrl),
      ).toBeNull();
    });
  });

  describe("verifyProxySignature canonical-form check", () => {
    it("rejects b64url with the impossible length mod 4 = 1", () => {
      expect.assertions(1);
      // 5 chars: 5 % 4 === 1, which canonical base64url never produces.
      expect(
        verifyProxySignature("AAAAAAAAAAAAAAAAAAAAAA", "AAAAA"),
      ).toBeNull();
    });

    it("rejects b64url with trailing-bit aliasing", () => {
      expect.assertions(2);
      const { sig, b64url } = signProxyUrl("https://example.com/a.png");
      // Round-trip succeeds with the canonical form …
      expect(verifyProxySignature(sig, b64url)).toBe(
        "https://example.com/a.png",
      );
      // … but if a client appends a padding-equivalent character to the
      // last base64url group, it must NOT decode to the same payload.
      expect(verifyProxySignature(sig, `${b64url}A`)).toBeNull();
    });
  });

  describe("parseMediaProxyMode", () => {
    it("defaults to off when unset", () => {
      expect.assertions(1);
      expect(parseMediaProxyMode(undefined)).toBe("off");
    });

    it("returns the named modes verbatim", () => {
      expect.assertions(3);
      expect(parseMediaProxyMode("off")).toBe("off");
      expect(parseMediaProxyMode("proxy")).toBe("proxy");
      expect(parseMediaProxyMode("cache")).toBe("cache");
    });

    it("maps boolean truthy values to proxy", () => {
      expect.assertions(3);
      expect(parseMediaProxyMode("true")).toBe("proxy");
      expect(parseMediaProxyMode("on")).toBe("proxy");
      expect(parseMediaProxyMode("1")).toBe("proxy");
    });

    it("maps boolean falsy values to off", () => {
      expect.assertions(2);
      expect(parseMediaProxyMode("false")).toBe("off");
      expect(parseMediaProxyMode("0")).toBe("off");
    });

    it("is case-insensitive", () => {
      expect.assertions(3);
      expect(parseMediaProxyMode("OFF")).toBe("off");
      expect(parseMediaProxyMode("True")).toBe("proxy");
      expect(parseMediaProxyMode("CACHE")).toBe("cache");
    });

    it("throws on unknown values", () => {
      expect.assertions(2);
      expect(() => parseMediaProxyMode("yes")).toThrow(/MEDIA_PROXY/);
      expect(() => parseMediaProxyMode("")).toThrow(/MEDIA_PROXY/);
    });
  });

  describe("parseRemoteMediaThumbnails", () => {
    it("defaults to true when unset", () => {
      expect.assertions(1);
      expect(parseRemoteMediaThumbnails(undefined)).toBe(true);
    });

    it("accepts on/true/1 as true", () => {
      expect.assertions(3);
      expect(parseRemoteMediaThumbnails("on")).toBe(true);
      expect(parseRemoteMediaThumbnails("true")).toBe(true);
      expect(parseRemoteMediaThumbnails("1")).toBe(true);
    });

    it("accepts off/false/0 as false", () => {
      expect.assertions(3);
      expect(parseRemoteMediaThumbnails("off")).toBe(false);
      expect(parseRemoteMediaThumbnails("false")).toBe(false);
      expect(parseRemoteMediaThumbnails("0")).toBe(false);
    });

    it("throws on unknown values", () => {
      expect.assertions(1);
      expect(() => parseRemoteMediaThumbnails("maybe")).toThrow(
        /REMOTE_MEDIA_THUMBNAILS/,
      );
    });
  });
});
