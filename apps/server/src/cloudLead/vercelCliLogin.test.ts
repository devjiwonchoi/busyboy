import { describe, expect, it } from "vite-plus/test";

import { readVercelCliLogin } from "./vercelCliLogin.ts";

const NOW = 1_794_400_000_000;
const authFile = (token: string, expiresAtMs?: number) =>
  JSON.stringify({
    token,
    ...(expiresAtMs === undefined ? {} : { expiresAt: Math.floor(expiresAtMs / 1000) }),
  });

describe("readVercelCliLogin", () => {
  it("uses a login that is still valid without running the CLI", async () => {
    let renewed = 0;
    const token = await readVercelCliLogin({
      readAuthFile: async () => authFile("fresh", NOW + 60 * 60 * 1000),
      renew: async () => {
        renewed += 1;
      },
      now: () => NOW,
    });
    expect(token).toBe("fresh");
    expect(renewed).toBe(0);
  });

  it("renews an expired login by running the CLI, then uses the new token", async () => {
    let file = authFile("expired", NOW - 60 * 60 * 1000);
    const token = await readVercelCliLogin({
      readAuthFile: async () => file,
      renew: async () => {
        file = authFile("renewed", NOW + 8 * 60 * 60 * 1000);
      },
      now: () => NOW,
    });
    expect(token).toBe("renewed");
  });

  it("says to log in again when the CLI cannot renew the login", async () => {
    await expect(
      readVercelCliLogin({
        readAuthFile: async () => authFile("expired", NOW - 1000),
        renew: async () => {
          throw new Error("npx not found");
        },
        now: () => NOW,
      }),
    ).rejects.toThrow("npx vercel login");
  });

  it("has no token without a CLI login", async () => {
    const token = await readVercelCliLogin({
      readAuthFile: async () => {
        throw new Error("ENOENT");
      },
      renew: async () => undefined,
      now: () => NOW,
    });
    expect(token).toBeNull();
  });
});
