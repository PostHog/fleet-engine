import { expect, test } from "bun:test";
import { literal } from "./proof-receipt.ts";

const pattern = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const escaped = (text: string) => text.replace(/[\\`*_~[\]<>&!]/g, "\\$&");

function byPattern(text: string) {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += escaped(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + escaped(text.slice(last));
}

test("literal keeps the same code spans as the receipt pattern did, on every short mix of backticks, letters and stars", () => {
  const alphabet = ["`", "a", "*"];
  for (let length = 1; length <= 9; length++) {
    for (let code = 0; code < alphabet.length ** length; code++) {
      const text = Array.from({ length }, (_, place) => alphabet[Math.floor(code / alphabet.length ** place) % alphabet.length]).join("");
      expect({ text, out: literal(text) }).toEqual({ text, out: byPattern(text) });
    }
  }
});
