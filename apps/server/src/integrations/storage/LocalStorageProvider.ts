import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageProvider } from "./StorageProvider";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/**
 * Filesystem storage for development and single-host deployments. Files are private to
 * the server process; the API streams them to authorised users only.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local-fs";

  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid storage key "${key}"`);
    return path.join(this.rootDir, ...key.split("/"));
  }

  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write-then-rename so readers never see a partial file.
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

/** In-memory storage for tests. */
export class MemoryStorageProvider implements StorageProvider {
  readonly name = "memory";
  readonly objects = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer) {
    this.objects.set(key, Buffer.from(bytes));
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
