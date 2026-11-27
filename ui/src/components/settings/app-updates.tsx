/**
 * Desktop app only: whether the app looks for a new version when it starts, and a button that
 * looks now. A newer version is offered in the app's own dialog (install and restart, or later).
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { updateCheckMessage, type AppSettings, type NativeApi } from '@/lib/native';

const muted = { color: 'var(--color-text-muted)' };

export function AppUpdates({ nativeApi }: { nativeApi: NativeApi }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    nativeApi
      .getAppSettings()
      .then((s) => live && setSettings(s))
      .catch(() => live && setSettings({ schema: 1, checkUpdatesAtLaunch: true }));
    return () => {
      live = false;
    };
  }, [nativeApi]);

  const setAtLaunch = async (on: boolean) => {
    if (!settings) return;
    const next = { ...settings, checkUpdatesAtLaunch: on };
    setSettings(next);
    try {
      await nativeApi.setAppSettings(next);
    } catch (e) {
      setSettings(settings);
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      const message = updateCheckMessage(await nativeApi.checkForUpdates());
      if (message) toast.info(message);
    } catch (e) {
      toast.error(`The update check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="settings-updates-at-launch">Check for updates when the app starts</Label>
          <p className="text-xs" style={muted}>
            A few seconds after launch the app looks for a new version and asks before installing
            it.
          </p>
        </div>
        <Switch
          id="settings-updates-at-launch"
          checked={settings?.checkUpdatesAtLaunch ?? true}
          disabled={!settings}
          onCheckedChange={(on) => void setAtLaunch(on)}
          data-testid="settings-updates-at-launch"
        />
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void checkNow()}
        disabled={checking}
        data-testid="settings-check-updates"
      >
        {checking && <Loader2 className="w-4 h-4 animate-spin" />}
        {checking ? 'Checking…' : 'Check for updates'}
      </Button>
    </div>
  );
}
