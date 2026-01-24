import { useState, useEffect, useRef } from 'react';
import type { VfsExportData } from '@/lib/types/messages';
import { CopyDialog, type CopyTarget } from './CopyDialog';

/**
 * Normalize a URL path by removing trailing slashes (except for root "/")
 */
function normalizePath(path: string): string {
  if (path === '/' || path === '') return '/';
  return path.replace(/\/+$/, '');
}

interface VfsFile {
  name: string;
  version: number;
  modified: number;
}

interface FileInfo {
  name: string;
  version: number;
  modified: number;
}

interface AllFilesData {
  [domain: string]: {
    paths: {
      [urlPath: string]: {
        scripts: FileInfo[];
        styles: FileInfo[];
      };
    };
  };
}

interface ScriptsPanelProps {
  tabId: number | null;
  onClose: () => void;
}

export function ScriptsPanel({ tabId, onClose }: ScriptsPanelProps) {
  const [currentScripts, setCurrentScripts] = useState<VfsFile[]>([]);
  const [currentStyles, setCurrentStyles] = useState<VfsFile[]>([]);
  const [allFiles, setAllFiles] = useState<AllFilesData>({});
  const [currentDomain, setCurrentDomain] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [scriptsMatchedPattern, setScriptsMatchedPattern] = useState<string | null>(null);
  const [stylesMatchedPattern, setStylesMatchedPattern] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Track which file has copy dialog open: "domain|urlPath|type|name"
  const [copyDialogFile, setCopyDialogFile] = useState<string | null>(null);

  const loadFiles = async () => {
    if (!tabId) {
      setError('No tab ID');
      setLoading(false);
      return;
    }

    try {
      // Get current page's files
      const response = await browser.runtime.sendMessage({
        type: 'GET_VFS_FILES',
        tabId,
      });

      if (response.error) {
        setError(response.error);
      } else {
        setCurrentScripts(response.scripts || []);
        setCurrentStyles(response.styles || []);
        setScriptsMatchedPattern(response.scriptsMatchedPattern || null);
        setStylesMatchedPattern(response.stylesMatchedPattern || null);
        setError(null);
      }

      // Get current tab's URL
      const tab = await browser.tabs.get(tabId);
      if (tab.url) {
        const url = new URL(tab.url);
        setCurrentDomain(url.hostname);
        setCurrentPath(normalizePath(url.pathname));
      }

      // Get all files across all domains
      const allResponse = await browser.runtime.sendMessage({
        type: 'GET_ALL_VFS_FILES',
      });

      if (allResponse.success) {
        setAllFiles(allResponse.files || {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load files');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadFiles();
  }, [tabId]);

  const handleDelete = async (type: 'script' | 'style', name: string) => {
    if (!tabId) return;
    if (!confirm(`Delete ${name}?`)) return;

    try {
      await browser.runtime.sendMessage({
        type: 'DELETE_VFS_FILE',
        tabId,
        fileType: type,
        fileName: name,
      });
      await loadFiles();
    } catch (e) {
      alert('Failed to delete: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  };

  const handleCopy = async (
    sourceDomain: string,
    sourceUrlPath: string,
    fileType: 'script' | 'style',
    fileName: string,
    target: CopyTarget
  ) => {
    if (!tabId) return;

    try {
      const response = await browser.runtime.sendMessage({
        type: 'COPY_VFS_FILE',
        sourceDomain,
        sourceUrlPath,
        fileType,
        fileName,
        targetTabId: tabId,
        targetPath: target.path,
      });

      if (!response.success) {
        alert('Copy failed: ' + response.error);
        return;
      }

      const pathDesc = target.type === 'exact' ? 'current page' :
                       target.type === 'pattern' ? `pattern ${target.path}` :
                       target.type === 'catchAll' ? `${target.path} (and below)` :
                       target.path;
      alert(`Copied ${fileName} to ${pathDesc}`);
      setCopyDialogFile(null);
      await loadFiles();
    } catch (e) {
      alert('Copy failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  };

  const openCopyDialog = (domain: string, urlPath: string, fileType: 'script' | 'style', fileName: string) => {
    setCopyDialogFile(`${domain}|${urlPath}|${fileType}|${fileName}`);
  };

  const closeCopyDialog = () => {
    setCopyDialogFile(null);
  };

  const handleDeleteAny = async (
    domain: string,
    urlPath: string,
    fileType: 'script' | 'style',
    fileName: string
  ) => {
    if (!confirm(`Delete ${fileName} from ${domain}${urlPath}?`)) return;

    try {
      const response = await browser.runtime.sendMessage({
        type: 'DELETE_VFS_FILE_ANY',
        domain,
        urlPath,
        fileType,
        fileName,
      });

      if (!response.success) {
        alert('Delete failed: ' + response.error);
        return;
      }

      await loadFiles();
    } catch (e) {
      alert('Delete failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  };

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  const handleExport = async () => {
    try {
      const response = await browser.runtime.sendMessage({ type: 'EXPORT_ALL_SCRIPTS' });

      if (!response.success) {
        alert('Export failed: ' + response.error);
        return;
      }

      const data = response.data as VfsExportData;
      const domainCount = Object.keys(data.domains).length;

      if (domainCount === 0) {
        alert('No scripts to export');
        return;
      }

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `page-editor-scripts-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      alert(`Exported scripts from ${domainCount} domain(s)`);
    } catch (e) {
      alert('Export failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text) as VfsExportData;

      if (!data.version || !data.domains) {
        alert('Invalid export file format');
        return;
      }

      const response = await browser.runtime.sendMessage({
        type: 'IMPORT_ALL_SCRIPTS',
        data,
        tabId,
      });

      if (!response.success) {
        alert('Import failed: ' + response.error);
        return;
      }

      const domains = response.domainNames?.join(', ') || 'unknown';
      alert(`Imported ${response.importedFiles} file(s) for: ${domains}\n\nNote: Files only show when viewing the matching domain.`);

      await loadFiles();
    } catch (e) {
      alert('Import failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Check if a domain/path is the current page (or a pattern that matched the current page)
  const isCurrentPage = (domain: string, urlPath: string) => {
    if (domain !== currentDomain) return false;
    const normalizedUrlPath = normalizePath(urlPath);
    if (normalizedUrlPath === currentPath) return true;
    // Also consider as "current page" if files were matched from this pattern
    if (scriptsMatchedPattern && normalizedUrlPath === normalizePath(scriptsMatchedPattern)) return true;
    if (stylesMatchedPattern && normalizedUrlPath === normalizePath(stylesMatchedPattern)) return true;
    return false;
  };

  // Get other domains/paths (not current)
  const otherDomains = Object.entries(allFiles).filter(([domain, data]) => {
    // Check if this domain has any paths that are not the current page
    return Object.keys(data.paths).some(
      (urlPath) => !isCurrentPage(domain, urlPath)
    );
  });

  return (
    <div className="panel scripts-panel">
      <header className="panel-header">
        <h2>Saved Files</h2>
        <button className="close-button" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="panel-content">
        {loading ? (
          <p className="loading-text">Loading...</p>
        ) : error ? (
          <p className="error-text">Error: {error}</p>
        ) : (
          <>
            {/* Current Page Section */}
            <div className="file-section current-page-section">
              <h3>Current Page</h3>
              <p className="current-page-info">{currentDomain}{currentPath}</p>
              {(scriptsMatchedPattern || stylesMatchedPattern) && (
                <p className="matched-pattern-info">
                  Matched from: <code>{scriptsMatchedPattern || stylesMatchedPattern}</code>
                </p>
              )}

              {currentScripts.length === 0 && currentStyles.length === 0 ? (
                <p className="empty-text small">No saved files for this page</p>
              ) : (
                <>
                  {currentScripts.length > 0 && (
                    <div className="file-group">
                      <h4>Scripts ({currentScripts.length})</h4>
                      <ul className="files-list">
                        {currentScripts.map((file) => {
                          const fileKey = `${currentDomain}|${currentPath}|script|${file.name}`;
                          const showDialog = copyDialogFile === fileKey;
                          return (
                            <li key={file.name} className="file-item">
                              <div className="file-info">
                                <strong className="file-name">{file.name}</strong>
                                <span className="file-meta">
                                  v{file.version} • {formatDate(file.modified)}
                                </span>
                              </div>
                              <div className="file-actions">
                                <div className="copy-button-wrapper">
                                  <button
                                    className="file-button copy"
                                    onClick={() => openCopyDialog(currentDomain, currentPath, 'script', file.name)}
                                  >
                                    Copy to...
                                  </button>
                                  {showDialog && (
                                    <CopyDialog
                                      currentPath={currentPath}
                                      onCopy={(target) => handleCopy(currentDomain, currentPath, 'script', file.name, target)}
                                      onCancel={closeCopyDialog}
                                    />
                                  )}
                                </div>
                                <button
                                  className="file-button delete"
                                  onClick={() => handleDelete('script', file.name)}
                                >
                                  Delete
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {currentStyles.length > 0 && (
                    <div className="file-group">
                      <h4>Styles ({currentStyles.length})</h4>
                      <ul className="files-list">
                        {currentStyles.map((file) => {
                          const fileKey = `${currentDomain}|${currentPath}|style|${file.name}`;
                          const showDialog = copyDialogFile === fileKey;
                          return (
                            <li key={file.name} className="file-item">
                              <div className="file-info">
                                <strong className="file-name">{file.name}</strong>
                                <span className="file-meta">
                                  v{file.version} • {formatDate(file.modified)}
                                </span>
                              </div>
                              <div className="file-actions">
                                <div className="copy-button-wrapper">
                                  <button
                                    className="file-button copy"
                                    onClick={() => openCopyDialog(currentDomain, currentPath, 'style', file.name)}
                                  >
                                    Copy to...
                                  </button>
                                  {showDialog && (
                                    <CopyDialog
                                      currentPath={currentPath}
                                      onCopy={(target) => handleCopy(currentDomain, currentPath, 'style', file.name, target)}
                                      onCancel={closeCopyDialog}
                                    />
                                  )}
                                </div>
                                <button
                                  className="file-button delete"
                                  onClick={() => handleDelete('style', file.name)}
                                >
                                  Delete
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Other Domains Section */}
            {otherDomains.length > 0 && (
              <div className="file-section other-domains-section">
                <h3>Other Saved Files</h3>

                {otherDomains.map(([domain, data]) => (
                  <div key={domain} className="domain-group">
                    {Object.entries(data.paths).map(([urlPath, files]) => {
                      if (isCurrentPage(domain, urlPath)) return null;

                      const sectionKey = `${domain}${urlPath}`;
                      const isExpanded = expandedSections.has(sectionKey);
                      const totalFiles = files.scripts.length + files.styles.length;

                      return (
                        <div key={sectionKey} className="collapsible-section">
                          <button
                            className="collapsible-header"
                            onClick={() => toggleSection(sectionKey)}
                          >
                            <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                            <span className="section-title">
                              {domain}{urlPath}
                            </span>
                            <span className="section-count">{totalFiles} file(s)</span>
                          </button>

                          {isExpanded && (
                            <div className="collapsible-content">
                              {files.scripts.length > 0 && (
                                <div className="file-group">
                                  <h4>Scripts</h4>
                                  <ul className="files-list">
                                    {files.scripts.map((file) => {
                                      const fileKey = `${domain}|${urlPath}|script|${file.name}`;
                                      const showDialog = copyDialogFile === fileKey;
                                      return (
                                        <li key={file.name} className="file-item">
                                          <div className="file-info">
                                            <strong className="file-name">{file.name}</strong>
                                            <span className="file-meta">
                                              v{file.version} • {formatDate(file.modified)}
                                            </span>
                                          </div>
                                          <div className="file-actions">
                                            <div className="copy-button-wrapper">
                                              <button
                                                className="file-button copy"
                                                onClick={() => openCopyDialog(domain, urlPath, 'script', file.name)}
                                              >
                                                Copy
                                              </button>
                                              {showDialog && (
                                                <CopyDialog
                                                  currentPath={currentPath}
                                                  onCopy={(target) => handleCopy(domain, urlPath, 'script', file.name, target)}
                                                  onCancel={closeCopyDialog}
                                                />
                                              )}
                                            </div>
                                            <button
                                              className="file-button delete"
                                              onClick={() => handleDeleteAny(domain, urlPath, 'script', file.name)}
                                            >
                                              Delete
                                            </button>
                                          </div>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}

                              {files.styles.length > 0 && (
                                <div className="file-group">
                                  <h4>Styles</h4>
                                  <ul className="files-list">
                                    {files.styles.map((file) => {
                                      const fileKey = `${domain}|${urlPath}|style|${file.name}`;
                                      const showDialog = copyDialogFile === fileKey;
                                      return (
                                        <li key={file.name} className="file-item">
                                          <div className="file-info">
                                            <strong className="file-name">{file.name}</strong>
                                            <span className="file-meta">
                                              v{file.version} • {formatDate(file.modified)}
                                            </span>
                                          </div>
                                          <div className="file-actions">
                                            <div className="copy-button-wrapper">
                                              <button
                                                className="file-button copy"
                                                onClick={() => openCopyDialog(domain, urlPath, 'style', file.name)}
                                              >
                                                Copy
                                              </button>
                                              {showDialog && (
                                                <CopyDialog
                                                  currentPath={currentPath}
                                                  onCopy={(target) => handleCopy(domain, urlPath, 'style', file.name, target)}
                                                  onCancel={closeCopyDialog}
                                                />
                                              )}
                                            </div>
                                            <button
                                              className="file-button delete"
                                              onClick={() => handleDeleteAny(domain, urlPath, 'style', file.name)}
                                            >
                                              Delete
                                            </button>
                                          </div>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <button className="refresh-button" onClick={loadFiles} disabled={loading}>
          Refresh
        </button>

        <div className="export-import-buttons">
          <button className="export-button" onClick={handleExport}>
            Export All
          </button>
          <button className="import-button" onClick={handleImportClick}>
            Import
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImportFile}
            accept=".json"
            style={{ display: 'none' }}
          />
        </div>
      </div>
    </div>
  );
}
