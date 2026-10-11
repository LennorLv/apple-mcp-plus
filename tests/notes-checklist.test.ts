import { test, expect } from "bun:test";
import { gzipSync } from "node:zlib";
import { decodeNativeChecklist, readNativeChecklists } from "../utils/notes-checklist";

function varint(n: number): Buffer {
  const bytes: number[] = [];
  do { bytes.push((n % 128) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n);
  return Buffer.from(bytes);
}
function field(n: number, value: number | Buffer): Buffer {
  return typeof value === "number" ? Buffer.concat([varint(n * 8), varint(value)]) :
    Buffer.concat([varint(n * 8 + 2), varint(value.length), value]);
}
function document(text: string, spans: { text: string; done?: number; style?: number }[]): Buffer {
  const runs = spans.map(span => field(5, Buffer.concat([
    field(1, span.text.length), field(2, Buffer.concat([
      field(1, span.style ?? (span.done === undefined ? 0 : 103)),
      ...(span.done === undefined ? [] : [field(5, field(2, span.done))]),
    ])),
  ])));
  return gzipSync(field(2, field(3, Buffer.concat([field(2, Buffer.from(text)), ...runs]))));
}

test("native state handles Chinese, emoji UTF-16 offsets and split styling without duplicate items", () => {
  const title = "标题 🍎\n", a = "任务 A 🍎\n", b = "任务 B\n", c = "普通列表\n";
  const decoded = decodeNativeChecklist(document(title + a + b + c, [
    { text: title }, { text: "任务", done: 0 }, { text: " A 🍎\n", done: 0 },
    { text: b, done: 1 }, { text: c, style: 100 },
  ]));
  expect(decoded.items).toEqual([
    { line: 2, text: "任务 A 🍎", checked: false }, { line: 3, text: "任务 B", checked: true },
  ]);
});
test("plain text markers and ordinary bullet paragraphs are not native checklists", () => {
  const text = "- [ ] text\n普通列表\n";
  expect(decodeNativeChecklist(document(text, [{ text, style: 100 }])).items).toEqual([]);
});
test("malformed, unknown states and conflicting spans fail instead of returning false completion", () => {
  expect(() => decodeNativeChecklist(Buffer.from("bad gzip"))).toThrow();
  expect(() => decodeNativeChecklist(gzipSync(Buffer.from([18, 10, 1])))).toThrow();
  expect(() => decodeNativeChecklist(document("A\n", [{ text: "A\n", done: 2 }]))).toThrow();
  expect(() => decodeNativeChecklist(document("AB\n", [{ text: "A", done: 0 }, { text: "B\n", done: 1 }]))).toThrow();
  expect(() => decodeNativeChecklist(document("AB\n", [{ text: "A", done: 0 }]))).toThrow();
});
test("unsupported identifiers degrade explicitly without querying personal data", async () => {
  const states = await readNativeChecklists([{ id: "invalid'); DROP TABLE notes; --", content: "" }]);
  expect([...states.values()][0]).toMatchObject({ status: "unavailable", items: [], error: "Unsupported Notes identifier" });
});
