import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

export function buildQueryScript(body: string, parameters: unknown): string {
  // User input is JSON data, never executable source or AppleScript syntax.
  const input = JSON.stringify(JSON.stringify(parameters));
  return `JSON.stringify((function(p) { ${body}\n})(JSON.parse(${input})));`;
}

export async function runQuery<T>(
  body: string,
  parameters: unknown,
  schema: z.ZodType<T>,
  timeoutMs = 20000,
): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await execute("osascript", ["-l", "JavaScript", "-e",
      buildQueryScript(body, parameters)], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as { killed?: boolean; stderr?: string };
    // Do not include the full command: it may contain personal query input.
    throw new Error(failure.killed ? `Apple application query timed out after ${timeoutMs / 1000} seconds`
      : `Apple application query failed: ${failure.stderr?.trim() || "Unable to run osascript"}`);
  }
  let data: unknown;
  try { data = JSON.parse(stdout); }
  catch { throw new Error("Apple application returned invalid JSON"); }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error("Apple application returned an unexpected data structure");
  return parsed.data;
}

export const queryOptionsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  fromDate: z.string().datetime({ offset: true }).optional(),
  toDate: z.string().datetime({ offset: true }).optional(),
}).refine(p => !p.fromDate || !p.toDate || Date.parse(p.fromDate) < Date.parse(p.toDate), {
  message: "fromDate must be earlier than toDate",
});

export function validateQueryOptions(options: unknown) {
  return queryOptionsSchema.parse(options);
}
