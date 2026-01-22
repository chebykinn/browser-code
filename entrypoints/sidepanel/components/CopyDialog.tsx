import { useState, useRef, useEffect } from 'react';

export type CopyTarget =
  | { type: 'exact'; path: string }
  | { type: 'pattern'; path: string }
  | { type: 'catchAll'; path: string }
  | { type: 'custom'; path: string };

interface CopyDialogProps {
  currentPath: string;
  onCopy: (target: CopyTarget) => void;
  onCancel: () => void;
}

/**
 * Generate a dynamic route pattern from a URL path.
 * Replaces the last segment with [slug].
 * e.g., /products/123 -> /products/[slug]
 * e.g., /users/abc/posts -> /users/abc/[slug]
 */
function generatePatternPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '/[slug]';

  segments[segments.length - 1] = '[slug]';
  return '/' + segments.join('/');
}

/**
 * Generate a catch-all pattern from a URL path.
 * Keeps all segments except the last, adds [...path].
 * e.g., /products/123 -> /products/[...path]
 * e.g., /users/abc/posts/456 -> /users/abc/posts/[...path]
 */
function generateCatchAllPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '/[...path]';
  if (segments.length === 1) return '/[...path]';

  const parentSegments = segments.slice(0, -1);
  return '/' + parentSegments.join('/') + '/[...path]';
}

export function CopyDialog({ currentPath, onCopy, onCancel }: CopyDialogProps) {
  const [selectedOption, setSelectedOption] = useState<'exact' | 'pattern' | 'catchAll' | 'custom'>('exact');
  const [customPath, setCustomPath] = useState(currentPath);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const patternPath = generatePatternPath(currentPath);
  const catchAllPath = generateCatchAllPath(currentPath);

  // Focus custom input when selected
  useEffect(() => {
    if (selectedOption === 'custom' && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [selectedOption]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onCancel]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handleConfirm = () => {
    switch (selectedOption) {
      case 'exact':
        onCopy({ type: 'exact', path: currentPath });
        break;
      case 'pattern':
        onCopy({ type: 'pattern', path: patternPath });
        break;
      case 'catchAll':
        onCopy({ type: 'catchAll', path: catchAllPath });
        break;
      case 'custom':
        onCopy({ type: 'custom', path: customPath });
        break;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <div className="copy-dialog" ref={dialogRef}>
      <div className="copy-dialog-title">Copy to:</div>

      <label className="copy-option">
        <input
          type="radio"
          name="copyTarget"
          checked={selectedOption === 'exact'}
          onChange={() => setSelectedOption('exact')}
        />
        <div className="copy-option-content">
          <span className="copy-option-label">This page only</span>
          <code className="copy-option-path">{currentPath}</code>
        </div>
      </label>

      {patternPath !== currentPath && (
        <label className="copy-option">
          <input
            type="radio"
            name="copyTarget"
            checked={selectedOption === 'pattern'}
            onChange={() => setSelectedOption('pattern')}
          />
          <div className="copy-option-content">
            <span className="copy-option-label">Pattern match</span>
            <code className="copy-option-path">{patternPath}</code>
          </div>
        </label>
      )}

      <label className="copy-option">
        <input
          type="radio"
          name="copyTarget"
          checked={selectedOption === 'catchAll'}
          onChange={() => setSelectedOption('catchAll')}
        />
        <div className="copy-option-content">
          <span className="copy-option-label">This page and below</span>
          <code className="copy-option-path">{catchAllPath}</code>
        </div>
      </label>

      <label className="copy-option">
        <input
          type="radio"
          name="copyTarget"
          checked={selectedOption === 'custom'}
          onChange={() => setSelectedOption('custom')}
        />
        <div className="copy-option-content">
          <span className="copy-option-label">Custom path</span>
          {selectedOption === 'custom' && (
            <input
              ref={inputRef}
              type="text"
              className="copy-custom-input"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="/path/[param]/..."
            />
          )}
        </div>
      </label>

      <div className="copy-dialog-actions">
        <button className="copy-dialog-button cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="copy-dialog-button confirm" onClick={handleConfirm}>
          Copy
        </button>
      </div>
    </div>
  );
}
