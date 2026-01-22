import { useState } from 'react';
import type { Settings } from '@/lib/types/messages';

interface SettingsPanelProps {
  settings: Settings | null;
  onSave: (settings: Partial<Settings>) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: SettingsPanelProps) {
  const [apiKey, setApiKey] = useState(settings?.apiKey || '');
  const [model, setModel] = useState(settings?.model || 'claude-opus-4-5-20251101');

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
    </div>
  );
}
