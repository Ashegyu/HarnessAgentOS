export interface Thread {
  id: string;
  title: string;
  targetDir?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CreateThreadInput {
  title: string;
  targetDir?: string;
}

export interface UpdateThreadInput {
  title?: string;
  targetDir?: string;
  archivedAt?: string | null;
}
