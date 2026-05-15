import { parse } from "yaml";
import type { ExecutionEnv, FileInfo } from "./env.js";
import type { PromptTemplate } from "./types.js";

interface TemplateFrontmatter {
  description?: string;
  "argument-hint"?: string;
}

function parseFrontmatter<T>(content: string): { frontmatter: T; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {} as T, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {} as T, body: normalized };
  return {
    frontmatter: (parse(normalized.slice(4, end)) ?? {}) as T,
    body: normalized.slice(end + 4).trim(),
  };
}

export async function loadPromptTemplates(env: ExecutionEnv, dir: string): Promise<PromptTemplate[]> {
  if (!(await env.exists(dir))) return [];
  const entries = (await env.listDir(dir)).filter((e): e is FileInfo =>
    e.kind === "file" && e.name.endsWith(".md"),
  );
  const out: PromptTemplate[] = [];
  for (const entry of entries) {
    const raw = await env.readTextFile(entry.path);
    const { frontmatter, body } = parseFrontmatter<TemplateFrontmatter>(raw);
    const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
    out.push({
      name: entry.name.replace(/\.md$/, ""),
      description: frontmatter.description || firstLine.slice(0, 60),
      content: body,
    });
  }
  return out;
}

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

export function substituteArgs(content: string, args: string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, n: string) => args[parseInt(n, 10) - 1] ?? "");
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, sStr: string, lStr?: string) => {
    const start = Math.max(0, parseInt(sStr, 10) - 1);
    if (lStr) return args.slice(start, start + parseInt(lStr, 10)).join(" ");
    return args.slice(start).join(" ");
  });
  const all = args.join(" ");
  return result.replace(/\$ARGUMENTS/g, all).replace(/\$@/g, all);
}

export function formatPromptTemplateInvocation(t: PromptTemplate, args: string[] = []): string {
  return substituteArgs(t.content, args);
}
