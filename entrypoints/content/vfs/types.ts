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

export type FileType = 'page' | 'script' | 'style' | 'console' | 'screenshot';

export interface ParsedPath {
  domain: string;
  urlPath: string;
  fileType: FileType;
  fileName: string;
  fullPath: string;
}

/**
 * Result of listing files with route matching support
 */
export interface FileListResult {
  files: Array<{ name: string; version: number; modified: number }>;
  /** The pattern that matched, or null if no match/exact match */
  matchedPattern: string | null;
  /** Extracted route parameters */
  params: Record<string, string | string[]>;
}

/**
 * Result of reading a file with route matching support
 */
export interface FileReadResult {
  file: StoredFile | null;
  /** The pattern that matched */
  matchedPattern: string | null;
  /** Extracted route parameters */
  params: Record<string, string | string[]>;
}
