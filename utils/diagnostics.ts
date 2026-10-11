import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { eventkit } from "./eventkit";

async function readable(file: string) {
  try { const handle = await open(file, "r"); await handle.close(); return "readable"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "not_found" : ["EPERM", "EACCES"].includes(code || "") ? "permission_denied" : "unavailable";
  }
}
export async function diagnose(tool: string) {
  const native = await eventkit.call("status");
  const automation = native.automation as Record<string, string>;
  const fullDiskAccess: Record<string, string> = {};
  if (tool === "messages") fullDiskAccess.messagesDatabase = await readable(path.join(homedir(), "Library/Messages/chat.db"));
  if (tool === "notes") fullDiskAccess.notesDatabase = await readable(path.join(homedir(), "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"));
  return {tool, defaultBackend: ["calendar", "reminders"].includes(tool) ? "jxa" : "existing",
    eventkit: (native.eventkit as Record<string, string>)[tool] ?? "not_applicable",
    automation: automation[tool] ?? "not_applicable", accessibility: native.accessibility, fullDiskAccess,
    helper: native.helper, mcpHost: {executable: process.execPath, pid: process.pid, parentPid: process.ppid},
    permissionProbePrompts: false,
    notes: ["Automation and EventKit are separate permissions. authorize is explicit for EventKit.",
      "Database readability is a file probe, not a claim about the global Full Disk Access switch.",
      "Accessibility is the helper's effective state; the responsible launcher is determined by macOS.",
      "A granted permission does not verify network, account configuration, sync or query correctness."]};
}
