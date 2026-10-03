import assert from "node:assert/strict";
import test from "node:test";
import { bgSequence, mixRgb, paintBackground, parseAnsiRgb, rgbToAnsi256 } from "./color.ts";

test("parseAnsiRgb reads truecolor and 256-color sequences", () => {
  assert.deepEqual(parseAnsiRgb("\x1b[38;2;10;20;30m"), { r: 10, g: 20, b: 30 });
  assert.deepEqual(parseAnsiRgb("\x1b[2;48;2;1;2;3m"), { r: 1, g: 2, b: 3 });
  assert.deepEqual(parseAnsiRgb("\x1b[38;5;196m"), { r: 255, g: 0, b: 0 });
  assert.equal(parseAnsiRgb("\x1b[31m"), undefined);
});

test("mixRgb and rgbToAnsi256", () => {
  assert.deepEqual(mixRgb({ r: 0, g: 0, b: 0 }, { r: 100, g: 200, b: 50 }, 0.5), { r: 50, g: 100, b: 25 });
  assert.equal(rgbToAnsi256({ r: 255, g: 0, b: 0 }), 196);
  assert.equal(rgbToAnsi256({ r: 128, g: 128, b: 128 }), 244);
  assert.equal(bgSequence({ r: 1, g: 2, b: 3 }, "truecolor"), "\x1b[48;2;1;2;3m");
  assert.match(bgSequence({ r: 255, g: 0, b: 0 }, "256color"), /^\x1b\[48;5;196m$/);
});

test("paintBackground switches backgrounds on spans and after resets", () => {
  const out = paintBackground("ab\x1b[0mcd", "<R>", "<S>", [{ start: 1, end: 3 }]);
  assert.equal(out, "<R>a<S>b\x1b[0m<S>c<R>d");
  // An fg reset keeps the background; extended colors are not mistaken for resets.
  assert.equal(paintBackground("\x1b[38;5;0mx\x1b[39m", "<R>", "<S>", []), "<R>\x1b[38;5;0mx\x1b[39m");
});
