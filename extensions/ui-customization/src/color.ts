export type Rgb = { r: number; g: number; b: number };

const CUBE = [0, 95, 135, 175, 215, 255];
const BASIC: Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 49, b: 49 },
  { r: 13, g: 188, b: 121 },
  { r: 229, g: 229, b: 16 },
  { r: 36, g: 114, b: 200 },
  { r: 188, g: 63, b: 188 },
  { r: 17, g: 168, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 102, g: 102, b: 102 },
  { r: 241, g: 76, b: 76 },
  { r: 35, g: 209, b: 139 },
  { r: 245, g: 245, b: 67 },
  { r: 59, g: 142, b: 234 },
  { r: 214, g: 112, b: 214 },
  { r: 41, g: 184, b: 219 },
  { r: 255, g: 255, b: 255 },
];

export function ansi256ToRgb(index: number): Rgb {
  if (index < 16) return BASIC[index] ?? BASIC[0]!;
  if (index < 232) {
    const value = index - 16;
    return {
      r: CUBE[Math.floor(value / 36)]!,
      g: CUBE[Math.floor(value / 6) % 6]!,
      b: CUBE[value % 6]!,
    };
  }
  const gray = 8 + (index - 232) * 10;
  return { r: gray, g: gray, b: gray };
}

/** First 24-bit or 256-color fg/bg color in an SGR sequence. */
export function parseAnsiRgb(sequence: string): Rgb | undefined {
  const truecolor = /\x1b\[(?:[0-9;]*;)?(?:38|48);2;(\d+);(\d+);(\d+)/.exec(sequence);
  if (truecolor) {
    return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
  }
  const indexed = /\x1b\[(?:[0-9;]*;)?(?:38|48);5;(\d+)/.exec(sequence);
  return indexed ? ansi256ToRgb(Number(indexed[1])) : undefined;
}

export function mixRgb(base: Rgb, tint: Rgb, amount: number): Rgb {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return { r: mix(base.r, tint.r), g: mix(base.g, tint.g), b: mix(base.b, tint.b) };
}

/** Nearest xterm-256 index, from the color cube or the gray ramp. */
export function rgbToAnsi256({ r, g, b }: Rgb): number {
  const level = (value: number) =>
    value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40));
  const cube = 16 + 36 * level(r) + 6 * level(g) + level(b);
  const cubeRgb = ansi256ToRgb(cube);
  const grayIndex = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 232 + grayIndex;
  const grayRgb = ansi256ToRgb(gray);
  const distance = (c: Rgb) => (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
  return distance(grayRgb) < distance(cubeRgb) ? gray : cube;
}

export function bgSequence(rgb: Rgb, mode: string): string {
  return mode === "truecolor"
    ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`
    : `\x1b[48;5;${rgbToAnsi256(rgb)}m`;
}

const SGR = /\x1b\[([0-9;:]*)m/g;

function resetsBackground(params: string): boolean {
  if (params === "") return true;
  const parts = params.split(/[;:]/).map(Number);
  for (let k = 0; k < parts.length; k += 1) {
    const value = parts[k];
    if (value === 0 || value === 49) return true;
    // Skip the arguments of extended colors so `38;5;0` is not read as a reset.
    if (value === 38 || value === 48 || value === 58) {
      k += parts[k + 1] === 2 ? 4 : 2;
    }
  }
  return false;
}

/**
 * Paint a background behind already styled text: `rowBg` everywhere, and
 * `spanBg` over the given character spans of the underlying plain text.
 * Backgrounds survive resets emitted by syntax highlighting.
 */
export function paintBackground(
  styled: string,
  rowBg: string,
  spanBg: string,
  spans: { start: number; end: number }[],
): string {
  const inSpan = (index: number) => spans.some((span) => index >= span.start && index < span.end);
  let out = rowBg;
  let index = 0;
  let emphasized = false;
  let last = 0;
  const emitText = (text: string) => {
    for (const char of text) {
      const want = inSpan(index);
      if (want !== emphasized) {
        emphasized = want;
        out += emphasized ? spanBg : rowBg;
      }
      out += char;
      index += char.length;
    }
  };
  for (const match of styled.matchAll(SGR)) {
    emitText(styled.slice(last, match.index));
    out += match[0];
    if (resetsBackground(match[1] ?? "")) out += emphasized ? spanBg : rowBg;
    last = (match.index ?? 0) + match[0].length;
  }
  emitText(styled.slice(last));
  return out;
}
