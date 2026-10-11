import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export class NativeError extends Error {
  constructor(public readonly code: string, message: string, public readonly backend = "eventkit") { super(message); }
}
const responseSchema = z.object({
  requestId: z.string(), success: z.boolean(), result: z.record(z.unknown()).optional(),
  error: z.object({code: z.string(), message: z.string()}).optional(),
}).refine(r => r.success ? !!r.result && !r.error : !!r.error && !r.result);
type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class EventKitClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  constructor(private executable: string, private arguments_: string[] = []) {}
  private start() {
    if (this.child) return this.child;
    if (!existsSync(this.executable)) throw new NativeError("helper_unavailable", "EventKit helper is missing; run npm run build:native on macOS with Xcode Command Line Tools");
    const child = spawn(this.executable, this.arguments_, {stdio: "pipe"});
    this.child = child;
    let buffer = "";
    const fail = (error: NativeError) => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
      child.kill("SIGKILL");
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { fail(new NativeError("protocol_error", "EventKit response exceeded 8 MiB")); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const response = responseSchema.parse(JSON.parse(line));
          const p = this.pending.get(response.requestId);
          if (!p) { fail(new NativeError("protocol_error", "Unexpected EventKit request ID")); return; }
          this.pending.delete(response.requestId); clearTimeout(p.timer);
          if (response.success) p.resolve(response.result!);
          else p.reject(new NativeError(response.error!.code, response.error!.message));
        } catch { fail(new NativeError("protocol_error", "Invalid EventKit JSON response")); return; }
      }
    });
    child.stderr.on("data", () => {}); // Never echo possible framework diagnostics containing personal data.
    child.on("error", () => fail(new NativeError("helper_unavailable", "Unable to start EventKit helper")));
    child.stdin.on("error", () => fail(new NativeError("helper_exited", "EventKit input stream closed")));
    child.on("exit", () => fail(new NativeError("helper_exited", "EventKit helper exited before the request completed")));
    return child;
  }
  async call(operation: string, parameters: Record<string, unknown> = {}, timeoutMs = 35000): Promise<Record<string, unknown>> {
    z.number().int().min(10).max(65000).parse(timeoutMs);
    const child = this.start();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Killing a stuck synchronous EventKit query also cancels queued reads.
        // No request is silently retried; the next explicit call can start a new helper.
        if (this.child === child) this.close(new NativeError("timeout", "EventKit request deadline exceeded; outstanding reads cancelled"));
      }, timeoutMs);
      this.pending.set(requestId, {resolve, reject, timer});
      child.stdin.write(JSON.stringify({requestId, operation, parameters, timeoutMs: Math.max(1, timeoutMs - 1000)}) + "\n");
    });
  }
  close(error: NativeError = new NativeError("cancelled", "EventKit client closed")) {
    const child = this.child; this.child = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); child?.kill("SIGKILL");
  }
}
const direct = fileURLToPath(new URL("../dist/eventkit-helper", import.meta.url));
const bundled = fileURLToPath(new URL("./eventkit-helper", import.meta.url));
export const eventkit = new EventKitClient(existsSync(bundled) ? bundled : direct);
process.once("exit", () => eventkit.close());
process.stdin.once("end", () => eventkit.close());

export function errorResult(error: unknown, backend = "jxa") {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof NativeError ? error.code
    : /timed out/i.test(message) ? "timeout"
    : /permission|not authorized|-1743|authorization denied/i.test(message) ? "permission_denied"
    : /ambiguous|multiple .*match/i.test(message) ? "ambiguous_target"
    : /not found/i.test(message) ? "not_found"
    : /unexpected data|invalid JSON/i.test(message) ? "data_unavailable"
    : /required|invalid|unsupported.*property|ZodError/i.test(message) ? "invalid_arguments" : "operation_failed";
  return {content: [{type: "text" as const, text: message}], isError: true,
    structuredContent: {error: {code, message, backend: error instanceof NativeError ? error.backend : backend}, complete: false}};
}
