import {
  FS_PREFIX,
  IndexedDbKv,
  SEED_MARKER_KEY,
  validateStarterFiles,
  type HostKv,
} from "@fen-web/bindings";

export interface WorkspaceFile {
  /** Absolute vfs path, such as `/index.html`. */
  path: string;
  contents: string;
}

export interface WorkspaceTreeDirectory {
  name: string;
  path: string;
  directories: WorkspaceTreeDirectory[];
  files: Array<{ name: string; path: string }>;
}

/** A kv with the native atomic starter-seed operation. */
export interface SeedableWorkspaceKv extends HostKv {
  seedIfEmpty(files: Record<string, string>): Promise<boolean>;
}

/** Read the `fs:` keyspace using the same flat-key convention as the vfs
 * tools. Directories are implicit and are not returned as files. */
export async function readWorkspaceFiles(kv: HostKv): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  for (const key of await kv.list(FS_PREFIX)) {
    if (!key.startsWith(FS_PREFIX)) continue;
    const path = key.slice(FS_PREFIX.length);
    if (!path.startsWith("/")) continue;
    const contents = await kv.get(key);
    if (contents !== undefined) files.push({ path, contents });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Build a deterministic directory tree from absolute vfs file paths. This
 * is separate from DOM rendering so the tree logic can be tested without a
 * browser DOM implementation. */
export function buildWorkspaceTree(paths: readonly string[]): WorkspaceTreeDirectory {
  const root: WorkspaceTreeDirectory = {
    name: "/",
    path: "/",
    directories: [],
    files: [],
  };

  for (const rawPath of paths) {
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      let child = directory.directories.find((candidate) => candidate.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: directory.path === "/" ? `/${segment}` : `${directory.path}/${segment}`,
          directories: [],
          files: [],
        };
        directory.directories.push(child);
      }
      directory = child;
    }
    const name = segments[segments.length - 1];
    const filePath = directory.path === "/" ? `/${name}` : `${directory.path}/${name}`;
    if (!directory.files.some((file) => file.path === filePath)) {
      directory.files.push({ name, path: filePath });
    }
  }

  const sort = (directory: WorkspaceTreeDirectory): void => {
    directory.directories.sort((a, b) => a.name.localeCompare(b.name));
    directory.files.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of directory.directories) sort(child);
  };
  sort(root);
  return root;
}

/** Remove all vfs files and the seed marker, then atomically reseed the
 * supplied starter through IndexedDbKv's existing conditional transaction.
 * The starter is validated before deletion so a bad bundled starter cannot
 * destroy the user's workspace without yielding a replacement. */
export async function resetWorkspace(
  kv: SeedableWorkspaceKv,
  starterFiles: Record<string, string>,
): Promise<void> {
  const validFiles = validateStarterFiles(starterFiles);
  for (const key of await kv.list(FS_PREFIX)) await kv.delete(key);
  await kv.delete(SEED_MARKER_KEY);
  const seeded = await kv.seedIfEmpty(validFiles);
  if (!seeded) {
    throw new Error("fen-web workspace reset: starter seed was not committed");
  }
}

/** A browser-owned IndexedDB connection for the shell's read-only workspace
 * UI. The VM keeps its own SyncKvCache, so refresh first flushes that cache
 * and then reads the durable store through this connection. */
export class WorkspaceStorage {
  private readonly backing: IndexedDbKv;

  constructor(dbName: string) {
    this.backing = new IndexedDbKv(dbName);
  }

  async readFiles(): Promise<WorkspaceFile[]> {
    return readWorkspaceFiles(this.backing);
  }

  async resetToStarter(starterFiles: Record<string, string>): Promise<void> {
    await resetWorkspace(this.backing, starterFiles);
  }

  async close(): Promise<void> {
    await this.backing.close();
  }
}

export interface WorkspacePanelOptions {
  root: HTMLElement;
  dbName: string;
  starterFiles: Record<string, string>;
  /** Flush the VM's SyncKvCache before reading durable workspace contents. */
  flush?: () => Promise<void>;
  /** Stop the VM, reset storage, and optionally start it again. */
  onReset?: (storage: WorkspaceStorage) => Promise<void>;
  /** Test seam and confirmation surface for the destructive reset action. */
  confirm?: (message: string) => boolean;
  /** Set to zero to disable polling. */
  refreshIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface WorkspacePanelController {
  refresh(): Promise<void>;
  dispose(): Promise<void>;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render and operate the shell-owned workspace panel. It intentionally uses
 * native DOM nodes and textContent rather than HTML interpolation: agent
 * files are untrusted source text and must never become shell markup. */
export function createWorkspacePanel(options: WorkspacePanelOptions): WorkspacePanelController {
  const storage = new WorkspaceStorage(options.dbName);
  const filesByPath = new Map<string, WorkspaceFile>();
  let selectedPath: string | undefined;
  let files: WorkspaceFile[] = [];
  let disposed = false;
  let refreshInFlight: Promise<void> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const panel = element("details", "workspace-panel");
  panel.open = true;
  const summary = element("summary", "workspace-summary");
  summary.textContent = "Workspace";
  panel.append(summary);

  const toolbar = element("div", "workspace-toolbar");
  const refreshButton = element("button", "workspace-action");
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh";
  const downloadButton = element("button", "workspace-action");
  downloadButton.type = "button";
  downloadButton.textContent = "Download ZIP";
  const resetButton = element("button", "workspace-reset");
  resetButton.type = "button";
  resetButton.textContent = "Reset to starter";
  toolbar.append(refreshButton, downloadButton, resetButton);
  panel.append(toolbar);

  const status = element("p", "workspace-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Loading workspace…";
  panel.append(status);

  const body = element("div", "workspace-body");
  const treeContainer = element("nav", "workspace-tree");
  treeContainer.setAttribute("aria-label", "Workspace files");
  const viewer = element("section", "workspace-viewer-panel");
  const viewerTitle = element("h3", "workspace-viewer-title");
  viewerTitle.textContent = "Select a file";
  const viewerContent = element("pre", "workspace-viewer");
  viewerContent.textContent = "Click a file to view its contents.";
  viewer.append(viewerTitle, viewerContent);
  body.append(treeContainer, viewer);
  panel.append(body);
  options.root.replaceChildren(panel);

  const setStatus = (message: string): void => {
    status.textContent = message;
  };

  const selectFile = (file: WorkspaceFile): void => {
    selectedPath = file.path;
    viewerTitle.textContent = file.path;
    viewerContent.textContent = file.contents;
    for (const button of Array.from(treeContainer.querySelectorAll<HTMLButtonElement>(
      "[data-workspace-path]",
    ))) {
      button.classList.toggle("selected", button.dataset.workspacePath === file.path);
      button.setAttribute("aria-pressed", button.dataset.workspacePath === file.path ? "true" : "false");
    }
  };

  const renderDirectory = (directory: WorkspaceTreeDirectory): HTMLUListElement => {
    const list = element("ul", "workspace-tree-list");
    for (const child of directory.directories) {
      const item = element("li", "workspace-tree-directory");
      const details = element("details");
      details.open = true;
      const heading = element("summary");
      heading.textContent = `${child.name}/`;
      details.append(heading, renderDirectory(child));
      item.append(details);
      list.append(item);
    }
    for (const file of directory.files) {
      const item = element("li", "workspace-tree-file");
      const button = element("button");
      button.type = "button";
      button.className = "workspace-file";
      button.textContent = file.name;
      button.title = file.path;
      button.dataset.workspacePath = file.path;
      button.setAttribute("aria-pressed", selectedPath === file.path ? "true" : "false");
      button.addEventListener("click", () => {
        const selected = filesByPath.get(file.path);
        if (selected) selectFile(selected);
      });
      if (selectedPath === file.path) button.classList.add("selected");
      item.append(button);
      list.append(item);
    }
    return list;
  };

  const renderFiles = (): void => {
    filesByPath.clear();
    for (const file of files) filesByPath.set(file.path, file);
    const tree = buildWorkspaceTree(files.map((file) => file.path));
    treeContainer.replaceChildren();
    if (files.length === 0) {
      const empty = element("p", "workspace-empty");
      empty.textContent = "No files in the workspace.";
      treeContainer.append(empty);
    } else {
      treeContainer.append(renderDirectory(tree));
    }

    if (selectedPath) {
      const selected = filesByPath.get(selectedPath);
      if (selected) {
        viewerTitle.textContent = selected.path;
        viewerContent.textContent = selected.contents;
      } else {
        selectedPath = undefined;
        viewerTitle.textContent = "Select a file";
        viewerContent.textContent = "Click a file to view its contents.";
      }
    }
  };

  const refresh = (): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      if (disposed) return;
      let flushError: unknown;
      try {
        await options.flush?.();
      } catch (error) {
        // A failed write-back should not make already durable files
        // unviewable. Keep the warning visible while still reading the store.
        flushError = error;
        options.onError?.(error);
      }
      try {
        files = await storage.readFiles();
        renderFiles();
        setStatus(
          flushError
            ? `${files.length} file${files.length === 1 ? "" : "s"} (last save failed: ${errorMessage(flushError)})`
            : `${files.length} file${files.length === 1 ? "" : "s"}`,
        );
      } catch (error) {
        options.onError?.(error);
        setStatus(`Workspace unavailable: ${errorMessage(error)}`);
      }
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };

  const setBusy = (value: boolean): void => {
    refreshButton.disabled = value;
    downloadButton.disabled = value;
    resetButton.disabled = value;
  };

  refreshButton.addEventListener("click", () => void refresh());
  downloadButton.addEventListener("click", () => {
    void (async () => {
      setBusy(true);
      try {
        await refresh();
        if (files.length === 0) {
          setStatus("Nothing to download: the workspace is empty.");
          return;
        }
        const zip = createWorkspaceZip(files);
        // Copy into a plain ArrayBuffer for lib.dom's BlobPart type. The
        // generic Uint8Array buffer may be ArrayBufferLike in newer TS libs.
        const blobBytes = new ArrayBuffer(zip.byteLength);
        new Uint8Array(blobBytes).set(zip);
        const blob = new Blob([blobBytes], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const link = element("a");
        link.href = url;
        link.download = "workspace.zip";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setStatus(`Downloaded workspace.zip (${files.length} file${files.length === 1 ? "" : "s"})`);
      } catch (error) {
        options.onError?.(error);
        setStatus(`Download failed: ${errorMessage(error)}`);
      } finally {
        setBusy(false);
      }
    })();
  });
  resetButton.addEventListener("click", () => {
    void (async () => {
      const confirm = options.confirm ?? ((message: string) => window.confirm(message));
      if (!confirm("Reset the workspace to the starter project? This permanently deletes all vfs files.")) {
        return;
      }
      setBusy(true);
      setStatus("Resetting workspace…");
      try {
        // Do not let the initial/polling read render stale durable contents
        // after the destructive reset completes.
        if (refreshInFlight) await refreshInFlight;
        if (options.onReset) await options.onReset(storage);
        else await storage.resetToStarter(options.starterFiles);
        selectedPath = undefined;
        await refresh();
      } catch (error) {
        options.onError?.(error);
        setStatus(`Reset failed: ${errorMessage(error)}`);
      } finally {
        setBusy(false);
      }
    })();
  });

  const interval = options.refreshIntervalMs ?? 10_000;
  if (interval > 0) refreshTimer = setInterval(() => void refresh(), interval);
  void refresh();

  return {
    refresh,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      await storage.close();
    },
  };
}

interface ZipEntry {
  name: Uint8Array;
  contents: Uint8Array;
  crc: number;
  offset: number;
}

function crc32(contents: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function archivePath(path: string): string {
  const withoutRoot = path.replace(/^\/+/, "");
  return withoutRoot || ".";
}

/** Convert workspace files to a portable store-only ZIP. Archive names are
 * rooted at the workspace (the vfs `/index.html` becomes `index.html`) so an
 * extraction cannot be interpreted as an absolute filesystem path. */
export function createWorkspaceZip(files: readonly WorkspaceFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = 0;

  for (const file of files) {
    const name = archivePath(file.path);
    if (names.has(name)) throw new Error(`workspace ZIP: duplicate path ${name}`);
    names.add(name);
    const nameBytes = encoder.encode(name);
    const contents = encoder.encode(file.contents);
    const entry: ZipEntry = {
      name: nameBytes,
      contents,
      crc: crc32(contents),
      offset,
    };
    entries.push(entry);
    offset += 30 + nameBytes.length + contents.length;
  }

  if (entries.length > 0xffff || offset > 0xffffffff) {
    throw new Error("workspace ZIP: workspace is too large for a classic ZIP archive");
  }

  const centralSize = entries.reduce((size, entry) => size + 46 + entry.name.length, 0);
  if (centralSize > 0xffffffff) {
    throw new Error("workspace ZIP: central directory is too large");
  }
  const result = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  const writeLocal = (entry: ZipEntry): void => {
    const view = new DataView(result.buffer, result.byteOffset + cursor, 30);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, 0, true); // stored, no compression
    view.setUint16(10, 0, true); // DOS time: 00:00:00
    view.setUint16(12, 0x0021, true); // DOS date: 1980-01-01
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.contents.length, true);
    view.setUint32(22, entry.contents.length, true);
    view.setUint16(26, entry.name.length, true);
    view.setUint16(28, 0, true); // extra length
    result.set(entry.name, cursor + 30);
    result.set(entry.contents, cursor + 30 + entry.name.length);
    cursor += 30 + entry.name.length + entry.contents.length;
  };
  for (const entry of entries) writeLocal(entry);

  const centralOffset = cursor;
  for (const entry of entries) {
    const view = new DataView(result.buffer, result.byteOffset + cursor, 46);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true); // made by: DOS/2.0
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0x0021, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.contents.length, true);
    view.setUint32(24, entry.contents.length, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, entry.offset, true);
    result.set(entry.name, cursor + 46);
    cursor += 46 + entry.name.length;
  }

  const centralLength = cursor - centralOffset;
  const end = new DataView(result.buffer, result.byteOffset + cursor, 22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralLength, true);
  end.setUint32(16, centralOffset, true);
  end.setUint16(20, 0, true);
  return result;
}
