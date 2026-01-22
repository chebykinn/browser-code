/**
 * Virtual Filesystem Types
 */

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  version?: number;
  modified?: number;
}

export interface FileContent {
  content: string;
  version: number;
  lines: number;
  path: string;
}

export interface GrepMatch {
  path: string;
  line: number;
  content: string;
  match: string;
  context?: string;
}

export interface VFSError {
  code: 'NOT_FOUND' | 'VERSION_MISMATCH' | 'INVALID_PATH' | 'PERMISSION_DENIED';
  message: string;
  path: string;
  expectedVersion?: number;
  actualVersion?: number;
}

export interface EditRecord {
  selector: string;
  oldContent: string;
  newContent: string;
  timestamp: number;
}

export interface StoredFile {
  content: string;
  version: number;
  created: number;
  modified: number;
}

export interface DomainStorage {
  // URL path -> scripts/styles
  paths: Record<string, {
    scripts: Record<string, StoredFile>;
    styles: Record<string, StoredFile>;
    editRecords: EditRecord[];
  }>;
}

export type FileType = 'page' | 'script' | 'style';

export interface ParsedPath {
  domain: string;
  urlPath: string;
  fileType: FileType;
  fileName: string;
  fullPath: string;
}
