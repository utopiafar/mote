#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [rawDirectory, outputDirectory] = process.argv.slice(2);
if (!rawDirectory || !outputDirectory) {
  console.error("usage: export-screens.mjs <raw-attachments> <output>");
  process.exit(2);
}

const manifestPath = path.join(rawDirectory, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const exported = [];
const seen = new Set();

for (const test of manifest) {
  for (const attachment of test.attachments ?? []) {
    const suggested = attachment.suggestedHumanReadableName ?? "";
    if (!suggested.endsWith(".png")) continue;
    const name = suggested.replace(/_\d+_[0-9A-F-]+\.png$/i, "");
    if (!name) continue;
    const source = path.join(rawDirectory, attachment.exportedFileName);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(outputDirectory, `impl-${name}.png`);
    fs.copyFileSync(source, destination);
    if (!seen.has(name)) {
      seen.add(name);
      exported.push(name);
    }
  }
}

exported.sort();
fs.writeFileSync(path.join(outputDirectory, "screens.json"), `${JSON.stringify(exported, null, 2)}\n`);
console.log(`Exported ${exported.length} screens.`);
if (exported.length === 0) process.exit(1);
