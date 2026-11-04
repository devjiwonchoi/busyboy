import { useClientSettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { readBrowserPasswordsBridge } from "~/browser/browserPasswords";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Settings → Browser: whether the browser offers to save, and whether filling asks first. */
export function BrowserPasswordFillSettings() {
  if (readBrowserPasswordsBridge() === null) return null;
  return (
    <>
      <OfferToSavePasswordsSetting />
      <RequireDeviceAuthForFillSetting />
    </>
  );
}

function OfferToSavePasswordsSetting() {
  const enabled = useClientSettings((settings) => settings.browserOfferToSavePasswords);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("browser-offer-to-save-passwords")}
      description="After you sign in to a site in the browser, offer to save the password. Never offered in incognito or for sign-ins an agent typed."
      resetAction={
        !enabled ? (
          <SettingResetButton
            label="offer to save passwords"
            onClick={() => updateSettings({ browserOfferToSavePasswords: true })}
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ browserOfferToSavePasswords: Boolean(checked) })
          }
          aria-label="Offer to save passwords"
        />
      }
    />
  );
}

function RequireDeviceAuthForFillSetting() {
  const enabled = useClientSettings((settings) => settings.browserPasswordsRequireDeviceAuth);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("browser-passwords-require-device-auth")}
      description="Ask for Touch ID before filling a saved password. After you confirm, fills in the same profile skip it for a minute. Revealing or copying a password always asks."
      resetAction={
        !enabled ? (
          <SettingResetButton
            label="ask before filling passwords"
            onClick={() => updateSettings({ browserPasswordsRequireDeviceAuth: true })}
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ browserPasswordsRequireDeviceAuth: Boolean(checked) })
          }
          aria-label="Ask before filling passwords"
        />
      }
    />
  );
}
