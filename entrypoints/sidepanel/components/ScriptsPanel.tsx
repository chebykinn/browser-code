import { useState, useEffect, useRef } from 'react';
import type { VfsExportData } from '@/lib/types/messages';
import { CopyDialog, type CopyTarget } from './CopyDialog';
import { getSyncManager } from '../sync';
import * as firefoxWriter from '../sync/file-writer-firefox';
import { parseRoutePattern, matchRoute } from '../../content/vfs/route-matcher';

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
  const folderInputRef = useRef<HTMLInputElement>(null);

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

      const syncManager = getSyncManager();
      const hasDirectWrite = syncManager.hasDirectWrite();
      const config = syncManager.getConfig();

      // If Chrome with directory handle, write individual files
      if (hasDirectWrite && config?.directoryHandle) {
        await syncManager.exportAll();
        alert(`Exported scripts from ${domainCount} domain(s) to sync folder`);
      } else if (firefoxWriter.isAvailable()) {
        // Firefox: export individual files to Downloads/browser-code-fs/
        const files: Array<{ domain: string; urlPath: string; type: 'scripts' | 'styles'; name: string; content: string }> = [];
        for (const [domain, domainData] of Object.entries(data.domains)) {
          for (const [urlPath, pathData] of Object.entries(domainData.paths)) {
            if (pathData.scripts) {
              for (const [name, fileData] of Object.entries(pathData.scripts)) {
                files.push({ domain, urlPath, type: 'scripts', name, content: fileData.content });
              }
            }
            if (pathData.styles) {
              for (const [name, fileData] of Object.entries(pathData.styles)) {
                files.push({ domain, urlPath, type: 'styles', name, content: fileData.content });
              }
            }
          }
        }
        await firefoxWriter.exportFiles(files);
        alert(`Exported ${files.length} file(s) from ${domainCount} domain(s) to Downloads/browser-code-fs/`);
      } else {
        // Fallback: old blob download method
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
      }
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

      // Cleanup duplicate paths after import
      await browser.runtime.sendMessage({ type: 'CLEANUP_VFS_PATHS' });

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

  const handleImportFolderClick = () => {
    folderInputRef.current?.click();
  };

  const handleImportFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      // Parse directory structure: {domain}/{urlPath}/scripts|styles/{filename}
      const vfsData: VfsExportData = {
        version: 1,
        exportedAt: Date.now(),
        domains: {},
      };

      for (const file of Array.from(files)) {
        // webkitRelativePath gives us the full path from selected folder
        const relativePath = file.webkitRelativePath;
        if (!relativePath) continue;

        // Only process .js and .css files
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext !== 'js' && ext !== 'css') continue;

        // Parse path: folder/domain/urlPath.../scripts|styles/filename
        const parts = relativePath.split('/');
        if (parts.length < 4) continue; // Need at least: folder/domain/type/file

        // Skip the root folder name (first part)
        const pathParts = parts.slice(1);

        // Find scripts or styles in path
        const typeIndex = pathParts.findIndex(p => p === 'scripts' || p === 'styles');
        if (typeIndex === -1 || typeIndex === 0) continue;

        const domain = pathParts[0];
        // Normalize urlPath: handle empty path as '/', remove trailing slashes
        const rawUrlPath = '/' + pathParts.slice(1, typeIndex).join('/');
        const urlPath = normalizePath(rawUrlPath);
        const fileType = pathParts[typeIndex] as 'scripts' | 'styles';
        const fileName = pathParts.slice(typeIndex + 1).join('/');

        // Read file content
        const content = await file.text();

        // Add to VFS data structure
        if (!vfsData.domains[domain]) {
          vfsData.domains[domain] = { paths: {} };
        }
        if (!vfsData.domains[domain].paths[urlPath]) {
          vfsData.domains[domain].paths[urlPath] = { scripts: {}, styles: {} };
        }

        vfsData.domains[domain].paths[urlPath][fileType][fileName] = {
          content,
          version: 1,
          created: file.lastModified,
          modified: file.lastModified,
        };
      }

      const domainCount = Object.keys(vfsData.domains).length;
      if (domainCount === 0) {
        alert('No valid files found in folder.\n\nExpected structure:\nfolder/{domain}/{path}/scripts/*.js\nfolder/{domain}/{path}/styles/*.css');
        return;
      }

      // Import using existing mechanism
      const response = await browser.runtime.sendMessage({
        type: 'IMPORT_ALL_SCRIPTS',
        data: vfsData,
        tabId,
      });

      if (!response.success) {
        alert('Import failed: ' + response.error);
        return;
      }

      // Cleanup duplicate paths after import
      await browser.runtime.sendMessage({ type: 'CLEANUP_VFS_PATHS' });

      const domains = response.domainNames?.join(', ') || 'unknown';
      alert(`Imported ${response.importedFiles} file(s) for: ${domains}\n\nNote: Files only show when viewing the matching domain.`);

      await loadFiles();
    } catch (e) {
      alert('Import failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }

    if (folderInputRef.current) {
      folderInputRef.current.value = '';
    }
  };

  // Check if a domain/path is the current page (or a pattern that matched the current page)
  const isCurrentPage = (domain: string, urlPath: string) => {
    if (domain !== currentDomain) return false;
    const normalizedUrlPath = normalizePath(urlPath);

    // Exact match
    if (normalizedUrlPath === currentPath) return true;

    // Check if urlPath is a pattern that matches currentPath
    // e.g., urlPath="/products/[id]", currentPath="/products/123"
    const routePattern = parseRoutePattern(normalizedUrlPath);
    const matchResult = matchRoute(currentPath, routePattern);
    if (matchResult) return true;

    return false;
  };

  // Check if a file is currently loaded (injected into the page)
  const isFileLoaded = (domain: string, urlPath: string, type: 'script' | 'style', fileName: string) => {
    if (domain !== currentDomain) return false;
    const files = type === 'script' ? currentScripts : currentStyles;
    return files.some(f => f.name === fileName);
  };

  // Auto-expand matching paths on load
  useEffect(() => {
    if (!currentDomain || !allFiles[currentDomain]) return;

    const matchingPaths = Object.keys(allFiles[currentDomain].paths).filter(urlPath =>
      isCurrentPage(currentDomain, urlPath)
    );

    if (matchingPaths.length > 0) {
      setExpandedSections(prev => {
        const next = new Set(prev);
        matchingPaths.forEach(urlPath => next.add(`${currentDomain}${urlPath}`));
        return next;
      });
    }
  }, [currentDomain, allFiles, currentPath]);

  // Check if domain has any files
  const hasFiles = Object.keys(allFiles).length > 0;

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
            {/* Current page info */}
            <div className="current-page-info-section">
              <p className="current-page-info">{currentDomain}{currentPath}</p>
            </div>

            {/* Unified file tree */}
            {!hasFiles ? (
              <p className="empty-text">No saved files</p>
            ) : (
              <div className="file-section file-tree-section">
                {Object.entries(allFiles).map(([domain, data]) => (
                  <div key={domain} className="domain-group">
                    {Object.entries(data.paths).map(([urlPath, files]) => {
                      const sectionKey = `${domain}${urlPath}`;
                      const isExpanded = expandedSections.has(sectionKey);
                      const isMatching = isCurrentPage(domain, urlPath);
                      const totalFiles = files.scripts.length + files.styles.length;

                      return (
                        <div key={sectionKey} className={`collapsible-section ${isMatching ? 'matching' : ''}`}>
                          <button
                            className="collapsible-header"
                            onClick={() => toggleSection(sectionKey)}
                          >
                            <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                            <span className="section-title">
                              {domain}{urlPath}
                            </span>
                            <span className="section-count">{totalFiles} file(s)</span>
                            {isMatching && <span className="matching-indicator" title="Matches current page">●</span>}
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
                                      const loaded = isFileLoaded(domain, urlPath, 'script', file.name);
                                      return (
                                        <li key={file.name} className={`file-item ${loaded ? 'loaded' : ''}`}>
                                          <div className="file-info">
                                            <strong className="file-name">
                                              {loaded && <span className="loaded-indicator" title="Loaded">✓</span>}
                                              {file.name}
                                            </strong>
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
                                      const loaded = isFileLoaded(domain, urlPath, 'style', file.name);
                                      return (
                                        <li key={file.name} className={`file-item ${loaded ? 'loaded' : ''}`}>
                                          <div className="file-info">
                                            <strong className="file-name">
                                              {loaded && <span className="loaded-indicator" title="Loaded">✓</span>}
                                              {file.name}
                                            </strong>
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
            Import JSON
          </button>
          <button className="import-button" onClick={handleImportFolderClick}>
            Import Folder
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImportFile}
            accept=".json"
            style={{ display: 'none' }}
          />
          <input
            type="file"
            ref={folderInputRef}
            onChange={handleImportFolder}
            // @ts-expect-error webkitdirectory is not in types but works in browsers
            webkitdirectory=""
            style={{ display: 'none' }}
          />
        </div>
      </div>
    </div>
  );
}
