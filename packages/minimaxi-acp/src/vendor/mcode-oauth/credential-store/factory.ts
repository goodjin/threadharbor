import { FileStore, type FileStoreOptions } from './file-store.ts';
import type { CredentialStore } from './types.ts';

export type CreateCredentialStoreOptions = FileStoreOptions;

export function createCredentialStore(options: CreateCredentialStoreOptions): CredentialStore {
  return new FileStore(options);
}
