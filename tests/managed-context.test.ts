import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadManagedSystemContext } from "../src/managed-context.js";

test("managed identity hook verifies read-only files and skill digests", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "crabhelm-managed-"));
  const root = path.join(state, "managed");
  const skillRoot = path.join(root, "skills", "safe-skill");
  await mkdir(skillRoot, { recursive: true });
  const instructions = { identity: "# Identity\n", soul: "# Soul\n", agents: "# Agents\n" };
  const skillContent = "# Safe skill\n";
  for (const [name, content] of [["IDENTITY.md", instructions.identity], ["SOUL.md", instructions.soul], ["AGENTS.md", instructions.agents], ["skills/safe-skill/SKILL.md", skillContent]]) {
    const file = path.join(root, name);
    await writeFile(file, content);
    await chmod(file, 0o444);
  }
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1, readOnly: true, clawId: "claw", instructions,
    skills: [{ name: "Safe skill", slug: "safe-skill", files: [{ path: "SKILL.md", content: skillContent, sha256: createHash("sha256").update(skillContent).digest("hex") }] }],
  }));
  await chmod(path.join(root, "manifest.json"), 0o444);
  await chmod(skillRoot, 0o555);
  await chmod(path.join(root, "skills"), 0o555);
  await chmod(root, 0o555);
  const context = await loadManagedSystemContext(state, "claw");
  assert.match(context, /# Identity/u);
  assert.match(context, /Managed skill: Safe skill/u);
  await chmod(path.join(root, "IDENTITY.md"), 0o644);
  await assert.rejects(loadManagedSystemContext(state, "claw"), /unsafe/u);
});
