/**
 * Desktop app only, the app's own settings for this computer: whether it looks for a new version
 * when it starts, a button that looks now (a newer version is offered in the app's own dialog),
 * and the terminal "Open in terminal" uses. One component, so the settings file is written from
 * one copy.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  updateCheckMessage,
  type AppSettings,
  type AvailableTerminal,
  type NativeApi,
  type TerminalId,
} from '@/lib/native';
import { isCheckingForUpdates } from '@/lib/update-progress';
import { useUpdateStore } from '@/store/update-store';

const muted = { color: 'var(--color-text-muted)' };

export function AppUpdates({ nativeApi }: { nativeApi: NativeApi }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [clicked, setClicked] = useState(false);
  const [terminals, setTerminals] = useState<AvailableTerminal[]>([]);
  // The check at launch shows here too.
  const appChecking = useUpdateStore((s) => isCheckingForUpdates(s.event));
  const checking = clicked || appChecking;

  useEffect(() => {
    let live = true;
    nativeApi
      .getAppSettings()
      .then((s) => live && setSettings(s))
      .catch(() => live && setSettings({ schema: 1, checkUpdatesAtLaunch: true }));
    nativeApi
      .getAvailableTerminals()
      .then((t) => live && setTerminals(t.filter((x) => x.available)))
      .catch(() => live && setTerminals([]));
    return () => {
      live = false;
    };
  }, [nativeApi]);

  const write = async (next: AppSettings) => {
    if (!settings) return;
    setSettings(next);
    try {
      await nativeApi.setAppSettings(next);
    } catch (e) {
      setSettings(settings);
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const setAtLaunch = (on: boolean) => {
    if (settings) void write({ ...settings, checkUpdatesAtLaunch: on });
  };

  const setTerminal = (id: string) => {
    if (!settings) return;
    const next: AppSettings = {
      schema: settings.schema,
      checkUpdatesAtLaunch: settings.checkUpdatesAtLaunch,
    };
    if (id) next.terminal = id as TerminalId;
    void write(next);
  };

  const checkNow = async () => {
    setClicked(true);
    try {
      const message = updateCheckMessage(await nativeApi.checkForUpdates());
      if (message) toast.info(message);
    } catch (e) {
      toast.error(`The update check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setClicked(false);
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
        {checking ? 'Checking for updates…' : 'Check for updates'}
      </Button>
      <div
        className="flex items-start justify-between gap-4 border-t pt-4"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="space-y-1">
          <Label htmlFor="settings-terminal">Terminal for "Open in terminal"</Label>
          <p className="text-xs" style={muted}>
            Opens a task's worktree; the first one found when none is chosen.
          </p>
        </div>
        <select
          id="settings-terminal"
          className="h-9 rounded-md border bg-transparent px-2 text-sm"
          style={{ borderColor: 'var(--color-border)' }}
          value={settings?.terminal ?? ''}
          disabled={!settings}
          onChange={(e) => setTerminal(e.target.value)}
          data-testid="settings-terminal"
        >
          <option value="">First one found</option>
          {terminals.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
