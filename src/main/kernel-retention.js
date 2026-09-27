const fs = require('node:fs');
const path = require('node:path');

function parseFullVersion(version) {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return {
    version,
    major: Number(match[1]),
    parts: match.slice(1).map(Number),
  };
}

function compareFullVersions(left, right) {
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  return 0;
}

function cleanupOldKernelVersions(kernelsDir, protectedVersions = new Set()) {
  if (!fs.existsSync(kernelsDir)) return [];
  const protectedSet = protectedVersions instanceof Set
    ? protectedVersions
    : new Set(protectedVersions || []);
  const entries = fs.readdirSync(kernelsDir, { withFileTypes: true });
  const versions = entries
    .filter(entry => entry.isDirectory())
    .map(entry => parseFullVersion(entry.name))
    .filter(Boolean);
  const latestByMajor = new Map();

  for (const version of versions) {
    const latest = latestByMajor.get(version.major);
    if (!latest || compareFullVersions(version, latest) > 0) {
      latestByMajor.set(version.major, version);
    }
  }

  const removed = [];
  for (const version of versions) {
    const latest = latestByMajor.get(version.major);
    if (version.version === latest.version || protectedSet.has(version.version)) continue;
    fs.rmSync(path.join(kernelsDir, version.version), { recursive: true, force: true });
    removed.push(version.version);
  }
  return removed;
}

module.exports = { cleanupOldKernelVersions, parseFullVersion };
