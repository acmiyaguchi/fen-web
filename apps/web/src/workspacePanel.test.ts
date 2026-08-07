import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FS_PREFIX,
  MemoryKv,
  SEED_MARKER_KEY,
} from "@fen-web/bindings";
import {
  buildWorkspaceTree,
  createWorkspaceZip,
  readWorkspaceFiles,
  resetWorkspace,
  type SeedableWorkspaceKv,
} from "./workspacePanel.js";

class SeedableMemoryKv extends MemoryKv implements SeedableWorkspaceKv {
  async seedIfEmpty(files: Record<string, string>): Promise<boolean> {
    if (await this.get(SEED_MARKER_KEY) !== undefined) return false;
    if ((await this.list(FS_PREFIX)).length > 0) return false;
    for (const [path, contents] of Object.entries(files)) {
      await this.put(`${FS_PREFIX}${path}`, contents);
    }
    await this.put(SEED_MARKER_KEY, "seeded");
    return true;
  }
}

test("workspace reads only fs files and builds an ordered implicit directory tree", async () => {
  const kv = new MemoryKv();
  await kv.put("fs:/index.html", "<main />");
  await kv.put("fs:/src/app.js", "console.log(1)");
  await kv.put("fs:/src/lib/util.js", "export {};");
  await kv.put("env/apikey/ANTHROPIC_API_KEY", "secret");

  assert.deepEqual(await readWorkspaceFiles(kv), [
    { path: "/index.html", contents: "<main />" },
    { path: "/src/app.js", contents: "console.log(1)" },
    { path: "/src/lib/util.js", contents: "export {};" },
  ]);

  assert.deepEqual(buildWorkspaceTree([
    "/src/lib/util.js",
    "/index.html",
    "/src/app.js",
  ]), {
    name: "/",
    path: "/",
    directories: [{
      name: "src",
      path: "/src",
      directories: [{
        name: "lib",
        path: "/src/lib",
        directories: [],
        files: [{ name: "util.js", path: "/src/lib/util.js" }],
      }],
      files: [{ name: "app.js", path: "/src/app.js" }],
    }],
    files: [{ name: "index.html", path: "/index.html" }],
  });
});

test("resetWorkspace clears the vfs and marker before reseeding the starter", async () => {
  const kv = new SeedableMemoryKv();
  await kv.put("fs:/old.txt", "user work");
  await kv.put(SEED_MARKER_KEY, "old-seed");
  await kv.put("session:keep", "not workspace data");

  await resetWorkspace(kv, { "/index.html": "starter", "/app.js": "boot" });

  assert.deepEqual(await kv.list(FS_PREFIX), ["fs:/app.js", "fs:/index.html"]);
  assert.equal(await kv.get("fs:/index.html"), "starter");
  assert.equal(await kv.get(SEED_MARKER_KEY), "seeded");
  assert.equal(await kv.get("fs:/old.txt"), undefined);
  assert.equal(await kv.get("session:keep"), "not workspace data");
});

interface ZipEntryForTest {
  name: string;
  contents: string;
  crc: number;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** Minimal unzip of the store-only subset emitted by createWorkspaceZip. It
 * follows the central directory, then verifies each local header and returns
 * the reconstructed workspace paths/content. */
function unzipStoreOnly(bytes: Uint8Array): ZipEntryForTest[] {
  const end = bytes.length - 22;
  assert.equal(readU32(bytes, end), 0x06054b50, "ZIP must end in EOCD");
  const count = readU16(bytes, end + 10);
  const centralSize = readU32(bytes, end + 12);
  const centralOffset = readU32(bytes, end + 16);
  assert.equal(centralOffset + centralSize, end, "central directory should precede EOCD");

  const decoder = new TextDecoder();
  const entries: ZipEntryForTest[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(readU32(bytes, cursor), 0x02014b50, "central entry signature");
    const method = readU16(bytes, cursor + 10);
    assert.equal(method, 0, "workspace ZIP should use store-only entries");
    const crc = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    assert.equal(readU32(bytes, localOffset), 0x04034b50, "local entry signature");
    assert.equal(readU16(bytes, localOffset + 8), method);
    assert.equal(readU32(bytes, localOffset + 14), crc, "local and central CRC should match");
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    assert.equal(localNameLength, nameLength);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    assert.equal(compressedSize, uncompressedSize);
    const content = bytes.slice(contentStart, contentStart + uncompressedSize);
    entries.push({ name, contents: decoder.decode(content), crc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function crc32ForTest(contents: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(contents)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("createWorkspaceZip round-trips UTF-8 file paths and contents", () => {
  const zip = createWorkspaceZip([
    { path: "/index.html", contents: "<h1>starter</h1>" },
    { path: "/src/été.js", contents: "export const café = true;" },
  ]);
  assert.deepEqual(unzipStoreOnly(zip), [
    {
      name: "index.html",
      contents: "<h1>starter</h1>",
      crc: crc32ForTest("<h1>starter</h1>"),
    },
    {
      name: "src/été.js",
      contents: "export const café = true;",
      crc: crc32ForTest("export const café = true;"),
    },
  ]);
});

test("createWorkspaceZip rejects duplicate archive paths", () => {
  assert.throws(
    () => createWorkspaceZip([
      { path: "/same.txt", contents: "one" },
      { path: "same.txt", contents: "two" },
    ]),
    /duplicate path same\.txt/,
  );
});

