export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const CSI = /(?:\x1b|\u001b|←)\[([0-9;:?]*)([@-~])/g;

const ANSI_16 = [
  "#0f172a",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#3b82f6",
  "#a855f7",
  "#06b6d4",
  "#e5e7eb",
] as const;

const ANSI_16_BRIGHT = [
  "#64748b",
  "#f87171",
  "#4ade80",
  "#facc15",
  "#60a5fa",
  "#c084fc",
  "#22d3ee",
  "#f8fafc",
] as const;

export const parseAnsiSgr = (text: string): AnsiSegment[] => {
  const segments: AnsiSegment[] = [];
  const style: AnsiStyle = {};
  let cursor = 0;
  let match: RegExpExecArray | null;

  CSI.lastIndex = 0;
  while ((match = CSI.exec(text)) !== null) {
    appendSegment(segments, text.slice(cursor, match.index), style);
    const params = match[1] ?? "";
    const final = match[2] ?? "";
    if (final === "m") applySgrParams(style, params);
    cursor = CSI.lastIndex;
  }

  appendSegment(segments, text.slice(cursor), style);
  return segments.length > 0 ? segments : [{ text: "", style: {} }];
};

const appendSegment = (
  segments: AnsiSegment[],
  text: string,
  style: AnsiStyle,
): void => {
  if (text.length === 0) return;
  segments.push({ text, style: { ...style } });
};

const applySgrParams = (style: AnsiStyle, rawParams: string): void => {
  const codes = parseCodes(rawParams);
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i] ?? 0;
    if (code === 0) {
      resetStyle(style);
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.inverse = true;
    } else if (code === 22) {
      delete style.bold;
      delete style.dim;
    } else if (code === 23) {
      delete style.italic;
    } else if (code === 24) {
      delete style.underline;
    } else if (code === 27) {
      delete style.inverse;
    } else if (code >= 30 && code <= 37) {
      style.fg = ANSI_16[code - 30];
    } else if (code === 39) {
      delete style.fg;
    } else if (code >= 40 && code <= 47) {
      style.bg = ANSI_16[code - 40];
    } else if (code === 49) {
      delete style.bg;
    } else if (code >= 90 && code <= 97) {
      style.fg = ANSI_16_BRIGHT[code - 90];
    } else if (code >= 100 && code <= 107) {
      style.bg = ANSI_16_BRIGHT[code - 100];
    } else if (code === 38 || code === 48) {
      i = applyExtendedColor(style, code === 38 ? "fg" : "bg", codes, i);
    }
  }
};

const parseCodes = (rawParams: string): number[] => {
  if (rawParams.length === 0) return [0];
  return rawParams
    .replaceAll(":", ";")
    .split(";")
    .map((part) => (part.length === 0 ? 0 : Number(part)))
    .filter((code) => Number.isInteger(code) && code >= 0);
};

const resetStyle = (style: AnsiStyle): void => {
  delete style.fg;
  delete style.bg;
  delete style.bold;
  delete style.dim;
  delete style.italic;
  delete style.underline;
  delete style.inverse;
};

const applyExtendedColor = (
  style: AnsiStyle,
  target: "fg" | "bg",
  codes: readonly number[],
  index: number,
): number => {
  const mode = codes[index + 1];
  if (mode === 5) {
    const color = codes[index + 2];
    if (typeof color === "number") {
      style[target] = ansi256ToCss(color);
      return index + 2;
    }
    return index + 1;
  }
  if (mode === 2) {
    const r = codes[index + 2];
    const g = codes[index + 3];
    const b = codes[index + 4];
    if (isByte(r) && isByte(g) && isByte(b)) {
      style[target] = `rgb(${r}, ${g}, ${b})`;
      return index + 4;
    }
    return index + 1;
  }
  return index;
};

const ansi256ToCss = (code: number): string => {
  if (code < 0) return ANSI_16[0];
  if (code < 8) return ANSI_16[code] ?? ANSI_16[0];
  if (code < 16) return ANSI_16_BRIGHT[code - 8] ?? ANSI_16_BRIGHT[0];
  if (code >= 232) {
    const value = Math.min(255, Math.max(0, 8 + (code - 232) * 10));
    return `rgb(${value}, ${value}, ${value})`;
  }
  const offset = code - 16;
  const r = Math.floor(offset / 36) % 6;
  const g = Math.floor(offset / 6) % 6;
  const b = offset % 6;
  return `rgb(${ansiCubeValue(r)}, ${ansiCubeValue(g)}, ${ansiCubeValue(b)})`;
};

const ansiCubeValue = (value: number): number =>
  value === 0 ? 0 : 55 + value * 40;

const isByte = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
