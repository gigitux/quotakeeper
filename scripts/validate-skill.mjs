#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const skillPath = process.argv[2];
if (!skillPath) {
  fail("Usage: validate-skill.mjs <skill-directory>");
}

const skillMdPath = path.join(skillPath, "SKILL.md");
const content = readFileSync(skillMdPath, "utf8");
const match = content.match(/^---\n([\s\S]*?)\n---/);
if (!match) {
  fail("SKILL.md must start with YAML frontmatter.");
}

const frontmatter = parseSimpleYaml(match[1]);
if (!frontmatter.name || !/^[a-z0-9-]{1,64}$/.test(frontmatter.name)) {
  fail("Skill frontmatter must include a hyphen-case name up to 64 characters.");
}
if (!frontmatter.description || frontmatter.description.trim().length === 0) {
  fail("Skill frontmatter must include a non-empty description.");
}
if (content.includes("[TODO:")) {
  fail("Skill must not contain TODO placeholders.");
}

console.log(`Skill validation passed: ${path.resolve(skillPath)}`);

function parseSimpleYaml(source) {
  const result = {};
  for (const line of source.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
