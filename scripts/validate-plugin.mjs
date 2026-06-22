#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const pluginPath = process.argv[2];
if (!pluginPath) {
  fail("Usage: validate-plugin.mjs <plugin-directory>");
}

const pluginRoot = path.resolve(pluginPath);
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

for (const field of ["name", "version", "description", "skills", "author", "interface"]) {
  if (manifest[field] === undefined) {
    fail(`plugin.json missing required field: ${field}`);
  }
}
if (manifest.name !== "quota-keeper") {
  fail("plugin.json name must be quota-keeper.");
}
if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
  fail("plugin.json version must be semver-like.");
}
if (!manifest.author?.name) {
  fail("plugin.json author.name is required.");
}
for (const field of [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "defaultPrompt",
]) {
  if (!manifest.interface?.[field]) {
    fail(`plugin.json interface.${field} is required.`);
  }
}
if (
  !Array.isArray(manifest.interface.capabilities) ||
  manifest.interface.capabilities.length === 0
) {
  fail("plugin.json interface.capabilities must be a non-empty array.");
}

const skillsPath = path.join(pluginRoot, manifest.skills);
const skillMdPath = path.join(skillsPath, "quota-goal-supervisor", "SKILL.md");
if (!existsSync(skillMdPath)) {
  fail("Declared skills path must contain quota-goal-supervisor/SKILL.md.");
}
if (JSON.stringify(manifest).includes("[TODO:")) {
  fail("plugin.json must not contain TODO placeholders.");
}

console.log(`Plugin validation passed: ${pluginRoot}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
