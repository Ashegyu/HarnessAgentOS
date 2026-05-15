export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "em"; children: MarkdownInline[] }
  | { kind: "delete"; children: MarkdownInline[] }
  | { kind: "link"; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; depth: number; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "blockquote"; blocks: MarkdownBlock[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" };

export const parseMarkdownLite = (source: string): MarkdownBlock[] => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = parseFenceStart(line);
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !isFenceClose(lines[i] ?? "", fence.marker)) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({
        kind: "code",
        language: fence.language,
        text: codeLines.join("\n"),
      });
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        depth: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quoteLines.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", blocks: parseMarkdownLite(quoteLines.join("\n")) });
      continue;
    }

    const list = parseList(lines, i);
    if (list) {
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !isBlank(lines[i] ?? "") && !startsBlock(lines, i)) {
      paragraph.push((lines[i] ?? "").trim());
      i += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    }
  }

  return blocks;
};

export const parseMarkdownInline = (source: string): MarkdownInline[] => {
  const nodes: MarkdownInline[] = [];
  let i = 0;

  while (i < source.length) {
    if (source[i] === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        nodes.push({ kind: "code", text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    const strong = parseDelimitedInline(source, i, "**", "strong") ??
      parseDelimitedInline(source, i, "__", "strong");
    if (strong) {
      nodes.push(strong.node);
      i = strong.next;
      continue;
    }

    const deleted = parseDelimitedInline(source, i, "~~", "delete");
    if (deleted) {
      nodes.push(deleted.node);
      i = deleted.next;
      continue;
    }

    const em = parseDelimitedInline(source, i, "*", "em") ??
      parseDelimitedInline(source, i, "_", "em");
    if (em) {
      nodes.push(em.node);
      i = em.next;
      continue;
    }

    if (source[i] === "[") {
      const labelEnd = source.indexOf("](", i + 1);
      if (labelEnd > i + 1) {
        const hrefEnd = source.indexOf(")", labelEnd + 2);
        if (hrefEnd > labelEnd + 2) {
          nodes.push({
            kind: "link",
            href: source.slice(labelEnd + 2, hrefEnd).trim(),
            children: parseMarkdownInline(source.slice(i + 1, labelEnd)),
          });
          i = hrefEnd + 1;
          continue;
        }
      }
    }

    const next = nextInlineMarker(source, i + 1);
    appendText(nodes, source.slice(i, next));
    i = next;
  }

  return nodes;
};

const parseDelimitedInline = (
  source: string,
  index: number,
  delimiter: string,
  kind: "strong" | "em" | "delete",
): { node: MarkdownInline; next: number } | null => {
  if (!source.startsWith(delimiter, index)) return null;
  if (delimiter.length === 1 && source.startsWith(delimiter.repeat(2), index)) {
    return null;
  }
  const end = source.indexOf(delimiter, index + delimiter.length);
  if (end <= index + delimiter.length) return null;
  const children = parseMarkdownInline(source.slice(index + delimiter.length, end));
  return { node: { kind, children }, next: end + delimiter.length };
};

const appendText = (nodes: MarkdownInline[], text: string): void => {
  if (text.length === 0) return;
  const last = nodes[nodes.length - 1];
  if (last?.kind === "text") {
    last.text += text;
  } else {
    nodes.push({ kind: "text", text });
  }
};

const nextInlineMarker = (source: string, from: number): number => {
  const markers = ["`", "**", "__", "~~", "*", "_", "["]
    .map((marker) => source.indexOf(marker, from))
    .filter((index) => index >= 0);
  return markers.length > 0 ? Math.min(...markers) : source.length;
};

const startsBlock = (lines: readonly string[], index: number): boolean => {
  const line = lines[index] ?? "";
  if (parseFenceStart(line)) return true;
  if (/^(#{1,6})\s+/.test(line)) return true;
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (listMarker(line)) return true;
  return parseTable(lines, index) !== null;
};

const parseFenceStart = (
  line: string,
): { marker: string; language: string } | null => {
  const match = /^\s*(```+|~~~+)\s*([A-Za-z0-9_.+-]*)?.*$/.exec(line);
  if (!match) return null;
  return { marker: match[1]!, language: match[2] ?? "" };
};

const isFenceClose = (line: string, marker: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith(marker[0]!.repeat(marker.length));
};

const parseList = (
  lines: readonly string[],
  start: number,
): { block: Extract<MarkdownBlock, { kind: "ul" | "ol" }>; next: number } | null => {
  const first = listMarker(lines[start] ?? "");
  if (!first) return null;
  const items: string[] = [];
  let i = start;

  while (i < lines.length) {
    const marker = listMarker(lines[i] ?? "");
    if (!marker || marker.kind !== first.kind) break;
    items.push(marker.text);
    i += 1;
    while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? "") && !listMarker(lines[i] ?? "")) {
      items[items.length - 1] = `${items[items.length - 1]} ${(lines[i] ?? "").trim()}`;
      i += 1;
    }
  }

  return { block: { kind: first.kind, items }, next: i };
};

const listMarker = (
  line: string,
): { kind: "ul" | "ol"; text: string } | null => {
  const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
  if (unordered) return { kind: "ul", text: unordered[1]!.trim() };
  const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
  if (ordered) return { kind: "ol", text: ordered[1]!.trim() };
  return null;
};

const parseTable = (
  lines: readonly string[],
  start: number,
): { block: Extract<MarkdownBlock, { kind: "table" }>; next: number } | null => {
  const header = lines[start] ?? "";
  const separator = lines[start + 1] ?? "";
  if (!header.includes("|") || !isTableSeparator(separator)) return null;

  const headers = splitTableRow(header);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && (lines[i] ?? "").includes("|") && !isBlank(lines[i] ?? "")) {
    rows.push(splitTableRow(lines[i] ?? ""));
    i += 1;
  }

  return { block: { kind: "table", headers, rows }, next: i };
};

const splitTableRow = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};

const isTableSeparator = (line: string): boolean =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const isBlank = (line: string): boolean => line.trim().length === 0;
