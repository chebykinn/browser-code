import { useState, useEffect } from 'react';
import { getSyncManager, type SyncState } from '../sync';

interface SyncStatusProps {
  compact?: boolean;
}

export function SyncStatus({ compact = false }: SyncStatusProps) {
  const [state, setState] = useState<SyncState>({
    status: 'disabled',
    lastSync: null,
    pendingChanges: 0,
    error: null,
  });

  useEffect(() => {
    const manager = getSyncManager();
    setState(manager.getState());

    const unsubscribe = manager.on('status-change', (newState: SyncState) => {
      setState(newState);
    });

    return () => unsubscribe();
  }, []);

  const getStatusIcon = () => {
    switch (state.status) {
      case 'syncing':
        return '↻';
      case 'idle':
        return state.pendingChanges > 0 ? '●' : '✓';
      case 'error':
        return '✕';
      case 'disabled':
      default:
        return '○';
    }
  };

  const getStatusColor = () => {
    switch (state.status) {
      case 'syncing':
        return '#3b82f6'; // blue
      case 'idle':
        return state.pendingChanges > 0 ? '#f59e0b' : '#10b981'; // amber or green
      case 'error':
        return '#ef4444'; // red
      case 'disabled':
      default:
        return '#6b7280'; // gray
    }
  };

  const getStatusText = () => {
    switch (state.status) {
      case 'syncing':
        return 'Syncing...';
      case 'idle':
        if (state.pendingChanges > 0) {
          return `${state.pendingChanges} pending`;
        }
        return state.lastSync
          ? `Synced ${formatTime(state.lastSync)}`
          : 'Ready';
      case 'error':
        return state.error || 'Error';
      case 'disabled':
      default:
        return 'Sync disabled';
    }
  };

  const handleClick = async () => {
    const manager = getSyncManager();
    if (state.status !== 'disabled' && state.status !== 'syncing') {
      await manager.syncNow();
    }
  };

  if (compact) {
    return (
      <span
        className="sync-status-compact"
        style={{ color: getStatusColor(), cursor: state.status === 'disabled' ? 'default' : 'pointer' }}
        onClick={handleClick}
        title={getStatusText()}
      >
        {getStatusIcon()}
      </span>
    );
  }

  return (
    <div className="sync-status" onClick={handleClick}>
      <span className="sync-status-icon" style={{ color: getStatusColor() }}>
        {getStatusIcon()}
      </span>
      <span className="sync-status-text">{getStatusText()}</span>
      {state.status === 'error' && state.error && (
        <button
          className="sync-retry-button"
          onClick={(e) => {
            e.stopPropagation();
            getSyncManager().syncNow();
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) {
    return 'just now';
  } else if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  } else if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  } else {
    return new Date(timestamp).toLocaleDateString();
  }
}
