/** Русская форма множественного числа: plural(3, "проблема", "проблемы", "проблем"). */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Ближайший по написанию вариант, если он достаточно близок (опечатка). */
export function closestMatch(value: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(value.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const limit = Math.max(1, Math.min(3, Math.floor(value.length / 3)));
  return bestDistance <= limit ? best : null;
}

/** /Users/u/.pi/SDLC.md → ~/.pi/SDLC.md */
export function tildify(filePath: string, homeDir: string): string {
  if (homeDir && (filePath === homeDir || filePath.startsWith(homeDir + "/"))) {
    return "~" + filePath.slice(homeDir.length);
  }
  return filePath;
}

export function shortHash(hash: string): string {
  const [algo, hex] = hash.includes(":") ? hash.split(":", 2) : ["", hash];
  if (!hex || hex.length <= 8) return hash;
  return `${algo ? algo + ":" : ""}${hex.slice(0, 4)}…${hex.slice(-2)}`;
}
