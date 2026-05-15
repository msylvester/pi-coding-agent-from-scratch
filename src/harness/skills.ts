import { parse } from "yaml";
import type { ExecutionEnv } from "./env.js";
import type { Skill } from "./types.js";

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
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

export async function loadSkills(env: ExecutionEnv, dir: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  if (!(await env.exists(dir))) return skills;

  const entries = await env.listDir(dir);
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const skillPath = `${entry.path}/SKILL.md`;
    if (!(await env.exists(skillPath))) continue;
    const raw = await env.readTextFile(skillPath);
    const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw);
    if (!frontmatter.description) continue;
    skills.push({
      name: frontmatter.name ?? entry.name,
      description: frontmatter.description,
      content: body,
      filePath: skillPath,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    });
  }
  return skills;
}

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escape(s.name)}</name>`);
    lines.push(`    <description>${escape(s.description)}</description>`);
    lines.push(`    <location>${escape(s.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatSkillInvocation(skill: Skill, extra?: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\n${skill.content}\n</skill>`;
  return extra ? `${block}\n\n${extra}` : block;
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
