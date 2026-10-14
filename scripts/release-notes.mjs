// node scripts/release-notes.mjs
// Print the CHANGELOG.md section for the version in package.json. Fails when the
// section is missing, so a version bump always carries its notes.
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
const start = lines.findIndex((line) => line.trim() === `## v${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## v${version}" section`);
  process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
console.log(lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim());
