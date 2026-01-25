/**
 * Chrome file writing using File System Access API
 *
 * Uses showDirectoryPicker() to let user select a folder,
 * then writes files directly to that folder.
 */

const DB_NAME = 'browser-code-sync';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'directoryHandle';

/**
 * Open IndexedDB for handle storage
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Save directory handle to IndexedDB
 */
export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(handle, HANDLE_KEY);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();

    tx.oncomplete = () => db.close();
  });
}

/**
 * Get saved directory handle from IndexedDB
 */
export async function getHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(HANDLE_KEY);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);

    tx.oncomplete = () => db.close();
  });
}

/**
 * Clear saved handle
 */
export async function clearHandle(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(HANDLE_KEY);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();

    tx.oncomplete = () => db.close();
  });
}

/**
 * Verify and request permission for the handle
 */
export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'readwrite'
): Promise<boolean> {
  // Check current permission
  const options = { mode };

  // @ts-expect-error - queryPermission not fully typed
  const currentPermission = await handle.queryPermission(options);
  if (currentPermission === 'granted') {
    return true;
  }

  // Request permission
  // @ts-expect-error - requestPermission not fully typed
  const newPermission = await handle.requestPermission(options);
  return newPermission === 'granted';
}

/**
 * Prompt user to select a directory
 */
export async function selectDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    // @ts-expect-error - showDirectoryPicker not fully typed
    const handle = await window.showDirectoryPicker({
      id: 'browser-code-sync',
      mode: 'readwrite',
      startIn: 'documents',
    });

    // Save for later sessions
    await saveHandle(handle);

    return handle;
  } catch (error) {
    // User cancelled or permission denied
    if ((error as Error).name === 'AbortError') {
      return null;
    }
    throw error;
  }
}

/**
 * Get or create a subdirectory
 */
async function getOrCreateDirectory(
  parent: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  try {
    return await parent.getDirectoryHandle(name, { create: true });
  } catch (error) {
    throw new Error(`Failed to create directory "${name}": ${(error as Error).message}`);
  }
}

/**
 * Get nested directory, creating path as needed
 */
async function getNestedDirectory(
  root: FileSystemDirectoryHandle,
  path: string[]
): Promise<FileSystemDirectoryHandle> {
  let current = root;

  for (const segment of path) {
    if (!segment) continue;
    current = await getOrCreateDirectory(current, segment);
  }

  return current;
}

/**
 * Write a file to the selected directory
 *
 * @param handle - Root directory handle
 * @param relativePath - Path relative to root (e.g., "domain/scripts/app.js")
 * @param content - File content
 */
export async function writeFile(
  handle: FileSystemDirectoryHandle,
  relativePath: string,
  content: string
): Promise<void> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();

  if (!fileName) {
    throw new Error('Invalid path: no filename');
  }

  // Get or create parent directories
  const parentDir = parts.length > 0
    ? await getNestedDirectory(handle, parts)
    : handle;

  // Get or create file
  const fileHandle = await parentDir.getFileHandle(fileName, { create: true });

  // Write content
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

/**
 * Read a file from the directory
 */
export async function readFile(
  handle: FileSystemDirectoryHandle,
  relativePath: string
): Promise<string> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();

  if (!fileName) {
    throw new Error('Invalid path: no filename');
  }

  // Navigate to parent directory
  let current = handle;
  for (const segment of parts) {
    current = await current.getDirectoryHandle(segment);
  }

  // Get file
  const fileHandle = await current.getFileHandle(fileName);
  const file = await fileHandle.getFile();

  return await file.text();
}

/**
 * Delete a file from the directory
 */
export async function deleteFile(
  handle: FileSystemDirectoryHandle,
  relativePath: string
): Promise<void> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();

  if (!fileName) {
    throw new Error('Invalid path: no filename');
  }

  // Navigate to parent directory
  let current = handle;
  for (const segment of parts) {
    current = await current.getDirectoryHandle(segment);
  }

  // Delete file
  await current.removeEntry(fileName);
}

/**
 * List all files in the directory recursively
 */
export async function listFiles(
  handle: FileSystemDirectoryHandle,
  basePath = ''
): Promise<{ path: string; name: string }[]> {
  const files: { path: string; name: string }[] = [];

  // @ts-expect-error - entries() is valid but not in all type definitions
  for await (const [name, entry] of handle.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const path = basePath ? `${basePath}/${name}` : name;

    if (entry.kind === 'file') {
      files.push({ path, name });
    } else if (entry.kind === 'directory') {
      const subFiles = await listFiles(entry as FileSystemDirectoryHandle, path);
      files.push(...subFiles);
    }
  }

  return files;
}

/**
 * Check if File System Access API is available
 */
export function isAvailable(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}
