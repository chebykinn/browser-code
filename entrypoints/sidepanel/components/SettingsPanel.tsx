import { useState, useEffect } from 'react';
import type { Settings } from '@/lib/types/messages';
import { getSyncManager, type SyncState } from '../sync';

interface SettingsPanelProps {
  settings: Settings | null;
  onSave: (settings: Partial<Settings>) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: SettingsPanelProps) {
  const [apiKey, setApiKey] = useState(settings?.apiKey || '');
  const [model, setModel] = useState(settings?.model || 'claude-opus-4-5-20251101');

  // Sync settings
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [localPath, setLocalPath] = useState('');
  const [syncInterval, setSyncInterval] = useState(3000);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [hasDirectWrite, setHasDirectWrite] = useState(false);
  const [browserType, setBrowserType] = useState<'chrome' | 'firefox' | 'unknown'>('unknown');

  useEffect(() => {
    const manager = getSyncManager();
    manager.init().then(async () => {
      const config = manager.getConfig();
      if (config) {
        setSyncEnabled(config.enabled);
        setLocalPath(config.localPath);
        setSyncInterval(config.syncInterval);
      }
      setSyncState(manager.getState());
      setHasDirectWrite(manager.hasDirectWrite());
      setBrowserType(manager.getBrowser());
    });

    const unsubscribe = manager.on('status-change', (state: SyncState) => {
      setSyncState(state);
    });

    return () => unsubscribe();
  }, []);

  const handleSyncToggle = async (enabled: boolean) => {
    setSyncEnabled(enabled);
    await getSyncManager().setConfig({ enabled });
  };

  const handleLocalPathChange = async (path: string) => {
    setLocalPath(path);
    await getSyncManager().setConfig({ localPath: path });
  };

  const handleSyncIntervalChange = async (interval: number) => {
    setSyncInterval(interval);
    await getSyncManager().setConfig({ syncInterval: interval });
  };

  const handleSelectFolder = async () => {
    const success = await getSyncManager().selectDirectory();
    if (success) {
      setSyncEnabled(true);
      await getSyncManager().setConfig({ enabled: true });
    }
  };

  const handleSyncNow = async () => {
    await getSyncManager().syncNow();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ apiKey, model });
  };

  const canClose = settings?.apiKey;

  return (
    <div className="settings-panel">
      <header className="settings-header">
        <h2>Settings</h2>
        {canClose && (
          <button className="close-button" onClick={onClose}>
            ✕
          </button>
        )}
      </header>

      <form className="settings-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="apiKey">Anthropic API Key</label>
          <input
            type="password"
            id="apiKey"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
          />
          <p className="form-hint">
            Get your API key from{' '}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              console.anthropic.com
            </a>
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="claude-opus-4-5-20251101">Claude Opus 4.5 (best)</option>
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku (faster)</option>
          </select>
        </div>

        <button type="submit" className="save-button" disabled={!apiKey}>
          Save Settings
        </button>
      </form>

      <div className="settings-divider" />

      <div className="sync-settings">
        <h3>Local Filesystem Sync</h3>

        <div className="form-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(e) => handleSyncToggle(e.target.checked)}
            />
            Enable sync
          </label>
        </div>

        {browserType === 'chrome' && hasDirectWrite && (
          <div className="form-group">
            <label>Output Folder (Chrome)</label>
            <button
              type="button"
              className="select-folder-button"
              onClick={handleSelectFolder}
            >
              Select Folder
            </button>
            <p className="form-hint">
              Choose a folder where VFS files will be written directly.
            </p>
          </div>
        )}

        {browserType === 'firefox' && (
          <div className="form-group">
            <p className="form-hint">
              VFS changes auto-export to <code>Downloads/browser-code-fs/</code>
            </p>
            <p className="form-hint" style={{ color: '#f59e0b' }}>
              Note: Firefox cannot auto-read local files. Use "Import" in Scripts panel.
            </p>
          </div>
        )}

        {browserType === 'chrome' && (
          <div className="form-group">
            <label htmlFor="syncInterval">Sync Interval</label>
            <select
              id="syncInterval"
              value={syncInterval}
              onChange={(e) => handleSyncIntervalChange(Number(e.target.value))}
              disabled={!syncEnabled}
            >
              <option value={1000}>1 second</option>
              <option value={3000}>3 seconds</option>
              <option value={5000}>5 seconds</option>
              <option value={10000}>10 seconds</option>
            </select>
          </div>
        )}

        {syncState && syncEnabled && browserType === 'chrome' && (
          <div className="sync-status-panel">
            <div className="sync-status-row">
              <span>Status:</span>
              <span className={`sync-status-value sync-status-${syncState.status}`}>
                {syncState.status}
              </span>
            </div>
            {syncState.lastSync && (
              <div className="sync-status-row">
                <span>Last sync:</span>
                <span>{new Date(syncState.lastSync).toLocaleTimeString()}</span>
              </div>
            )}
            {syncState.error && (
              <div className="sync-status-row sync-error">
                <span>Error:</span>
                <span>{syncState.error}</span>
              </div>
            )}
            <button
              type="button"
              className="sync-now-button"
              onClick={handleSyncNow}
              disabled={syncState.status === 'syncing'}
            >
              Sync Now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
