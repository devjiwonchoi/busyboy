import type { BrowserPasswordImportSummary } from "@t3tools/contracts";

import { recency, type ChromiumPasswordPlan } from "../BrowserImport/ChromiumPasswords.ts";
import type { PasswordDatabase } from "./PasswordDatabase.ts";

/**
 * Adds imported logins in one transaction (spec 7, step 7):
 * - same site and username with the same password: skipped as a duplicate;
 * - different password: the newer one wins (counted as updated), and a
 *   BusyBoy login that is newer is never overwritten;
 * - Chrome's "never save" sites join the vault's list.
 */
export function importIntoVault(
  vault: PasswordDatabase,
  plan: ChromiumPasswordPlan,
  now: number,
): BrowserPasswordImportSummary {
  return vault.transaction(() => {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    for (const login of plan.logins) {
      const existing = vault.find(login.origin, login.username);
      if (existing === null) {
        vault.add({
          origin: login.origin,
          username: login.username,
          password: login.password,
          source: "imported_chrome",
          createdAt: login.createdAt > 0 ? login.createdAt : now,
          lastUsedAt: login.lastUsedAt,
        });
        imported += 1;
        continue;
      }
      if (vault.passwordEquals(existing.id, login.password)) {
        skipped += 1;
        continue;
      }
      const ours = Math.max(existing.updatedAt, existing.lastUsedAt ?? 0);
      if (recency(login) > ours) {
        vault.update(existing.id, { password: login.password }, now);
        updated += 1;
      } else {
        skipped += 1;
      }
    }
    let neverSave = 0;
    for (const origin of plan.neverSave) {
      if (vault.isNeverSave(origin)) continue;
      vault.addNeverSave(origin, now);
      neverSave += 1;
    }
    return { imported, updated, skipped, failed: plan.failed, neverSave };
  });
}
