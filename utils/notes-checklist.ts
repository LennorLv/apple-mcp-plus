import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";

const execute = promisify(execFile);
type Field = { number: number; value: number | Buffer };
export type NativeChecklistItem = { line: number; text: string; checked: boolean };

// Read only the protobuf fields we need, skipping unknown fields for forward compatibility.
function fields(bytes: Buffer): Field[] {
  let offset = 0;
  const result: Field[] = [];
  function varint(): number {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (offset >= bytes.length) throw new Error("Truncated Notes protobuf");
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid Notes protobuf varint");
  }
  function take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length)
      throw new Error("Truncated Notes protobuf field");
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  while (offset < bytes.length) {
    const tag = varint();
    if (!Number.isSafeInteger(tag) || tag < 8) throw new Error("Invalid Notes protobuf tag");
    const number = Math.floor(tag / 8);
    switch (tag % 8) {
      case 0: result.push({ number, value: varint() }); break;
      case 1: take(8); break;
      case 2: result.push({ number, value: take(varint()) }); break;
      case 5: take(4); break;
      default: throw new Error("Unsupported Notes protobuf wire type");
    }
  }
  return result;
}
function message(data: Field[], number: number): Field[] {
  const value = data.find(f => f.number === number)?.value;
  if (!Buffer.isBuffer(value)) throw new Error("Unsupported Notes document structure");
  return fields(value);
}
function scalar(data: Field[], number: number): number | undefined {
  const value = data.find(f => f.number === number)?.value;
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error("Invalid Notes protobuf scalar");
  return value;
}

export function decodeNativeChecklist(blob: Buffer): { text: string; items: NativeChecklistItem[] } {
  const document = message(fields(gunzipSync(blob, { maxOutputLength: 8 * 1024 * 1024 })), 2);
  const note = message(document, 3);
  const textBytes = note.find(f => f.number === 2)?.value;
  if (!Buffer.isBuffer(textBytes)) throw new Error("Notes document has no text");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(textBytes);
  // Apple's attribute lengths use UTF-16 units, which matches JavaScript string indices.
  let offset = 0;
  const states = new Map<number, boolean>();
  for (const field of note.filter(f => f.number === 5)) {
    if (!Buffer.isBuffer(field.value)) throw new Error("Invalid Notes attribute run");
    const run = fields(field.value);
    const length = scalar(run, 1);
    if (length === undefined || !Number.isSafeInteger(length) || length < 0 || offset + length > text.length)
      throw new Error("Invalid Notes attribute length");
    if (run.some(f => f.number === 2)) {
      const paragraph = message(run, 2);
      if (scalar(paragraph, 1) === 103) {
        const done = scalar(message(paragraph, 5), 2);
        if (done !== 0 && done !== 1) throw new Error("Unknown Notes checklist state");
        // A formatted checklist paragraph may span several attribute runs.
        for (let start = offset; start < offset + length;) {
          const line = text.slice(0, start).split("\n").length;
          if (states.has(line) && states.get(line) !== Boolean(done))
            throw new Error("Conflicting Notes checklist states");
          states.set(line, Boolean(done));
          const next = text.indexOf("\n", start);
          start = next < 0 ? offset + length : next + 1;
        }
      }
    }
    offset += length;
  }
  if (offset !== text.length) throw new Error("Incomplete Notes attribute coverage");
  const lines = text.split("\n");
  return { text, items: [...states].map(([line, checked]) => ({ line, text: lines[line - 1]!, checked })) };
}

export async function readNativeChecklists(notes: { id: string; content: string }[]) {
  const result = new Map<string, { status: "available" | "unavailable"; items: NativeChecklistItem[]; error?: string }>();
  const targets = notes.map(note => ({ note, pk: /\/ICNote\/p([1-9]\d*)$/.exec(note.id)?.[1] }));
  for (const { note, pk } of targets) if (!pk)
    result.set(note.id, { status: "unavailable", items: [], error: "Unsupported Notes identifier" });
  const supported = targets.filter(t => t.pk);
  try {
    for (let start = 0; start < supported.length; start += 100) {
      const batch = supported.slice(start, start + 100);
      // IDs are digits extracted above; no note text or user SQL enters this statement.
      const query = `SELECT n.Z_PK AS pk, n.ZISPASSWORDPROTECTED AS locked, hex(d.ZDATA) AS data
        FROM ZICCLOUDSYNCINGOBJECT n LEFT JOIN ZICNOTEDATA d ON d.Z_PK=n.ZNOTEDATA
        WHERE n.Z_PK IN (${batch.map(t => t.pk).join(",")}) AND COALESCE(n.ZMARKEDFORDELETION,0)=0`;
      const { stdout } = await execute("sqlite3", ["-readonly", "-json",
        `${homedir()}/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`, query],
        { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
      const rows = JSON.parse(stdout || "[]") as { pk: number; locked: number | null; data: string }[];
      for (const { note, pk } of batch) {
        try {
          const row = rows.find(r => String(r.pk) === pk);
          if (!row || row.locked || !row.data) throw new Error("Notes data missing, locked, or not locally synced");
          const decoded = decodeNativeChecklist(Buffer.from(row.data, "hex"));
          if (decoded.text.replace(/\r\n/g, "\n").trimEnd() !== note.content.replace(/\r\n/g, "\n").trimEnd())
            throw new Error("Notes database snapshot differs from scripting text; retry after sync");
          result.set(note.id, { status: "available", items: decoded.items });
        } catch (error) {
          result.set(note.id, { status: "unavailable", items: [], error: (error as Error).message });
        }
      }
    }
  } catch {
    for (const { note } of supported) if (!result.has(note.id))
      result.set(note.id, { status: "unavailable", items: [], error: "Notes database read failed (access, schema, or query error); verify Full Disk Access for the MCP host" });
  }
  return result;
}
