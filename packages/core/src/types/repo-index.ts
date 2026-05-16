export type RepoIndexFileKind =
  | "package"
  | "config"
  | "source"
  | "test"
  | "doc"
  | "style"
  | "other";

export interface RepoIndexFile {
  id: string;
  projectKey: string;
  targetDir: string;
  relativePath: string;
  fileKind: RepoIndexFileKind;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
  summary: string;
  symbols: string[];
  imports: string[];
  updatedAt: string;
}
