/**
 * Private object storage for transient image processing (PRD §50–51).
 * Objects are never exposed via public URLs; the API streams them to authorised users.
 */
export interface StorageProvider {
  readonly name: string;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}
