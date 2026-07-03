import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const maxContextBytes = 128 * 1024;

export async function loadManagedSystemContext(stateDir: string, childId: string): Promise<string> {
  const root = path.join(stateDir, "managed");
  await assertReadOnlyDirectory(root);
  const manifestText = await readManagedFile(path.join(root, "manifest.json"), 384 * 1024);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || manifest.readOnly !== true || manifest.clawId !== childId) {
    throw new Error("managed agent manifest does not match child identity");
  }
  const instructions = record(manifest.instructions);
  const sections: string[] = [];
  for (const [filename, key] of [["IDENTITY.md", "identity"], ["SOUL.md", "soul"], ["AGENTS.md", "agents"]] as const) {
    const content = await readManagedFile(path.join(root, filename), 64 * 1024);
    if (content !== stringValue(instructions[key])) throw new Error(`${filename} differs from managed manifest`);
    if (content.trim()) sections.push(content.trim());
  }
  const skills = manifest.skills;
  if (!Array.isArray(skills) || skills.length > 100) throw new Error("managed skill selection is invalid");
  for (const rawSkill of skills) {
    const skill = record(rawSkill);
    const slug = stringValue(skill.slug);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(slug)) throw new Error("managed skill slug is invalid");
    const files = skill.files;
    if (!Array.isArray(files)) throw new Error("managed skill files are invalid");
    const skillFile = files.map(record).find((file) => file.path === "SKILL.md");
    if (!skillFile) throw new Error(`managed skill ${slug} has no SKILL.md`);
    const content = await readManagedFile(path.join(root, "skills", slug, "SKILL.md"), 64 * 1024);
    if (content !== stringValue(skillFile.content) || sha256(content) !== stringValue(skillFile.sha256)) {
      throw new Error(`managed skill ${slug} failed integrity verification`);
    }
    sections.push(`## Managed skill: ${stringValue(skill.name)}\n\n${content.trim()}`);
  }
  const context = [`# Crabhelm managed identity`, ...sections].join("\n\n");
  if (Buffer.byteLength(context, "utf8") > maxContextBytes) throw new Error("managed agent context exceeds 128 KiB");
  return context;
}

async function assertReadOnlyDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o222) !== 0) {
    throw new Error("managed agent directory must be a read-only directory");
  }
}

async function readManagedFile(file: string, maxBytes: number): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) !== 0 || info.size > maxBytes) {
    throw new Error(`managed agent file is unsafe: ${path.basename(file)}`);
  }
  return readFile(file, "utf8");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed agent manifest object is invalid");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("managed agent manifest string is invalid");
  return value;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
