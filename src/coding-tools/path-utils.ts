import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function expandPath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return homedir() + filePath.slice(1);
  return filePath;
}

/** Resolve a path relative to cwd. Handles ~ expansion and absolute paths. */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) return expanded;
  return resolve(cwd, expanded);
}


