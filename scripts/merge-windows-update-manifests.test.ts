import { describe, expect, it } from "vite-plus/test";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "./merge-windows-update-manifests.ts";

// The shape electron-builder writes for an NSIS build.
const latest = (arch: string, releaseDate: string) => `version: 1.2.3
files:
  - url: BusyBoy-Setup-1.2.3-${arch}.exe
    sha512: sha-${arch}==
    size: ${arch === "x64" ? 100 : 200}
path: BusyBoy-Setup-1.2.3-${arch}.exe
sha512: sha-${arch}==
releaseDate: '${releaseDate}'
`;

describe("Windows update manifest merge", () => {
  it("lists both installers so each arch's updater finds its own", () => {
    const merged = mergeUpdateManifests([
      parseUpdateManifest(latest("x64", "2026-11-05T10:00:00.000Z"), "x64"),
      parseUpdateManifest(latest("arm64", "2026-11-05T10:05:00.000Z"), "arm64"),
    ]);
    const text = serializeUpdateManifest(merged);
    expect(text).toBe(`version: '1.2.3'
files:
  - url: BusyBoy-Setup-1.2.3-x64.exe
    sha512: sha-x64==
    size: 100
  - url: BusyBoy-Setup-1.2.3-arm64.exe
    sha512: sha-arm64==
    size: 200
releaseDate: '2026-11-05T10:05:00.000Z'
`);
    // Round-trips through the parser.
    expect(parseUpdateManifest(text, "merged")).toEqual(merged);
  });

  it("refuses manifests from different versions", () => {
    const other = latest("arm64", "2026-11-05T10:00:00.000Z").replace(
      "version: 1.2.3",
      "version: 1.2.4",
    );
    expect(() =>
      mergeUpdateManifests([
        parseUpdateManifest(latest("x64", "2026-11-05T10:00:00.000Z"), "x64"),
        parseUpdateManifest(other, "arm64"),
      ]),
    ).toThrow("Cannot merge versions 1.2.3 and 1.2.4.");
  });
});
