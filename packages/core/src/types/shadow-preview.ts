export interface ShadowPreview {
  id: string;
  taskRunId: string;
  approvalId: string;
  targetDir: string;
  relativePath: string;
  shadowPath: string;
  baselineHash?: string;
  artifactIds: string[];
  createdAt: string;
}
