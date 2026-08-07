import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readSkillCatalogFile,
  scanSkillCatalog,
  writeSkillCatalogFile
} from "../src/extensions/skillCatalog.js";

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biny-skill-catalog-"));
  try {
    const homeDir = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const sharedSkill = path.join(homeDir, ".codex", "skills", "shared-skill");
    await mkdir(sharedSkill, { recursive: true });
    await writeFile(path.join(sharedSkill, "SKILL.md"), "---\nname: shared-skill\ndescription: A shared local skill\n---\n# Shared skill\n\nUse this skill when testing the local catalog.\n");
    await mkdir(path.join(sharedSkill, "references"), { recursive: true });
    await writeFile(path.join(sharedSkill, "references", "guide.md"), "# Guide\n");

    const agentsSkillRoot = path.join(homeDir, ".agents", "skills");
    const claudeSkillRoot = path.join(homeDir, ".claude", "skills");
    await mkdir(agentsSkillRoot, { recursive: true });
    await mkdir(claudeSkillRoot, { recursive: true });
    await symlink(sharedSkill, path.join(agentsSkillRoot, "shared-skill"), "dir");
    await symlink(sharedSkill, path.join(claudeSkillRoot, "shared-skill"), "dir");

    const binySkill = path.join(homeDir, ".biny", "skills", "biny-only");
    await mkdir(binySkill, { recursive: true });
    await writeFile(path.join(binySkill, "skill.md"), "---\nname: biny-only\n---\n\nBiny body\n");

    const projectSkill = path.join(projectRoot, ".agents", "skills", "project-skill");
    await mkdir(projectSkill, { recursive: true });
    await writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: project-skill\ndescription: Project skill\n---\n\nProject body\n");

    const snapshot = await scanSkillCatalog({ homeDir, projectRoots: [projectRoot] });
    assert.equal(snapshot.warnings.length, 0);
    assert.deepEqual(snapshot.skills.map((skill) => skill.name), ["biny-only", "shared-skill", "project-skill"]);

    const shared = snapshot.skills.find((skill) => skill.name === "shared-skill");
    assert.ok(shared);
    assert.equal(shared.scope, "global");
    assert.equal(shared.description, "A shared local skill");
    assert.deepEqual(shared.linkedEngines, ["claude", "codex", "pi"]);
    assert.deepEqual(shared.frontmatter, { name: "shared-skill", description: "A shared local skill" });
    assert.deepEqual(shared.files.map((file) => file.path), ["SKILL.md", "references/guide.md"]);

    const guide = await readSkillCatalogFile(shared, "references/guide.md");
    assert.equal(guide.content, "# Guide\n");
    assert.equal(guide.binary, false);

    await writeSkillCatalogFile(shared, "references/guide.md", "# Updated guide\n");
    assert.equal(await readFile(path.join(shared.absolutePath, "references", "guide.md"), "utf8"), "# Updated guide\n");
    await assert.rejects(() => readSkillCatalogFile(shared, "../outside.txt"), /越界/);

    await fs.link(path.join(shared.absolutePath, "SKILL.md"), path.join(shared.absolutePath, "hard-link.md"));
    const withHardLink = await scanSkillCatalog({ homeDir });
    const refreshed = withHardLink.skills.find((skill) => skill.name === "shared-skill");
    assert.ok(refreshed);
    await assert.rejects(() => readSkillCatalogFile(refreshed, "hard-link.md"), /硬链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
