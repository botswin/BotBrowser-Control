function isNewerVersion(candidate, current) {
  const parse = value => {
    const normalized = String(value || '').replace(/^v/i, '');
    if (!/^\d+(?:\.\d+)*$/.test(normalized)) return null;
    return normalized.split('.').map(BigInt);
  };
  const left = parse(candidate);
  const right = parse(current);
  if (!left || !right) return false;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] || 0n;
    const b = right[i] || 0n;
    if (a !== b) return a > b;
  }
  return false;
}

module.exports = { isNewerVersion };
