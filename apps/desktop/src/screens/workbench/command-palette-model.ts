export type CommandPaletteGroup =
  | "tab"
  | "thread"
  | "learning"
  | "settings"
  | "taskrun";

export interface CommandPaletteItem {
  id: string;
  group: CommandPaletteGroup;
  title: string;
  subtitle?: string;
  keywords?: readonly string[];
  run: () => void;
}

export interface RankedCommandPaletteItem extends CommandPaletteItem {
  score: number;
}

export const filterCommandPaletteItems = (
  items: readonly CommandPaletteItem[],
  query: string,
): RankedCommandPaletteItem[] => {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length === 0) {
    return items.map((item, index) => ({ ...item, score: index }));
  }
  return items
    .map((item) => {
      const score = commandScore(item, normalizedQuery);
      return score === null ? null : { ...item, score };
    })
    .filter((item): item is RankedCommandPaletteItem => item !== null)
    .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
};

export const movePaletteSelection = (
  currentIndex: number,
  direction: "up" | "down",
  itemCount: number,
): number => {
  if (itemCount <= 0) return 0;
  const delta = direction === "down" ? 1 : -1;
  return (currentIndex + delta + itemCount) % itemCount;
};

const commandScore = (
  item: CommandPaletteItem,
  normalizedQuery: string,
): number | null => {
  const haystacks = [item.title, item.subtitle ?? "", ...(item.keywords ?? [])]
    .map(normalize)
    .filter(Boolean);
  let best: number | null = null;
  for (const text of haystacks) {
    const score = textScore(text, normalizedQuery);
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
};

const textScore = (text: string, query: string): number | null => {
  if (text === query) return 0;
  if (text.startsWith(query)) return 10 + (text.length - query.length);
  const index = text.indexOf(query);
  if (index >= 0) return 30 + index + (text.length - query.length);
  const fuzzy = fuzzySubsequenceScore(text, query);
  return fuzzy === null ? null : 80 + fuzzy;
};

const fuzzySubsequenceScore = (text: string, query: string): number | null => {
  let textIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  let gapPenalty = 0;
  for (const char of query) {
    const found = text.indexOf(char, textIndex);
    if (found === -1) return null;
    if (firstMatch === -1) firstMatch = found;
    if (lastMatch !== -1) gapPenalty += found - lastMatch - 1;
    lastMatch = found;
    textIndex = found + 1;
  }
  return firstMatch + gapPenalty + (text.length - query.length);
};

const normalize = (value: string): string =>
  value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
