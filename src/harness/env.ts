import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access, lstat, mkdir, mkdtemp, readdir, readFile,
  realpath, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type FileKind = "file" | "directory" | "symlink";

export class FileError extends Error {
  constructor(
    public code: FileErrorCode,
    message: string,
    public path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileError";
  }
}

export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;          // seconds
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecutionEnv {
  cwd: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readTextFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  fileInfo(path: string): Promise<FileInfo>;
  listDir(path: string): Promise<FileInfo[]>;
  realPath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  createDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  createTempDir(prefix?: string): Promise<string>;
  createTempFile(options?: { prefix?: string; suffix?: string }): Promise<string>;
  cleanup(): Promise<void>;
}

function toFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case "ENOENT":            return new FileError("not_found",          error.message, path);
      case "EACCES": case "EPERM": return new FileError("permission_denied", error.message, path);
      case "ENOTDIR":           return new FileError("not_directory",      error.message, path);
      case "EISDIR":            return new FileError("is_directory",       error.message, path);
      case "EINVAL":            return new FileError("invalid",            error.message, path);
    }
  }
  return new FileError("unknown", String(error), path);
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export class NodeExecutionEnv implements ExecutionEnv {
  cwd: string;
  constructor(options: { cwd: string }) { this.cwd = options.cwd; }

  async readTextFile(path: string): Promise<string> {
    const resolved = resolvePath(this.cwd, path);
    try { return await readFile(resolved, "utf8"); }
    catch (error) { throw toFileError(error, resolved); }
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    const resolved = resolvePath(this.cwd, path);
    try { return await readFile(resolved); }
    catch (error) { throw toFileError(error, resolved); }
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      await writeFile(resolved, content);
    } catch (error) { throw toFileError(error, resolved); }
  }

  async fileInfo(path: string): Promise<FileInfo> {
    const resolved = resolvePath(this.cwd, path);
    try {
      const stats = await lstat(resolved);
      const kind: FileKind =
        stats.isFile() ? "file" :
        stats.isDirectory() ? "directory" :
        stats.isSymbolicLink() ? "symlink" :
        (() => { throw new FileError("invalid", "Unsupported file type"); })();
      return {
        name: resolved.split("/").pop() ?? resolved,
        path: resolved,
        kind,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    } catch (error) {
      throw toFileError(error, resolved);
    }
  }

  async listDir(path: string): Promise<FileInfo[]> {
    const resolved = resolvePath(this.cwd, path);
    const entries = await readdir(resolved, { withFileTypes: true });
    const out: FileInfo[] = [];
    for (const entry of entries) {
      const p = resolve(resolved, entry.name);
      out.push(await this.fileInfo(p));
    }
    return out;
  }

  async realPath(path: string): Promise<string> {
    return await realpath(resolvePath(this.cwd, path));
  }

  async exists(path: string): Promise<boolean> {
    try { await this.fileInfo(path); return true; }
    catch (error) {
      if (error instanceof FileError && error.code === "not_found") return false;
      throw error;
    }
  }

  async createDir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(resolvePath(this.cwd, path), { recursive: options?.recursive });
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await rm(resolvePath(this.cwd, path), {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
  }

  async createTempDir(prefix: string = "tmp-"): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<string> {
    const dir = await this.createTempDir();
    const filePath = join(dir, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
    await writeFile(filePath, "");
    return filePath;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = options.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
    return await new Promise((resolvePromise, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn("/bin/bash", ["-c", command], {
        cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const timer =
        options.timeout != null
          ? setTimeout(() => child.pid && process.kill(-child.pid, "SIGKILL"),
                       options.timeout * 1000)
          : undefined;
      options.signal?.addEventListener("abort", () => {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      }, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => { stdout += c; options.onStdout?.(c); });
      child.stderr?.on("data", (c: string) => { stderr += c; options.onStderr?.(c); });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
      });
      child.on("error", reject);
    });
  }

  async cleanup(): Promise<void> { /* nothing to do for local Node */ }
}
