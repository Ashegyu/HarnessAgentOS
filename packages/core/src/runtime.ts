export type RuntimePlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

export interface RuntimeInfo {
  platform: RuntimePlatform;
  appDataDir: string;
  documentsDir?: string;
  appVersion: string;
}
