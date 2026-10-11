# Apple MCP Plus

[English](README.md) · [简体中文](README.zh-CN.md)

Local macOS MCP tools for **Contacts, Notes, Messages, Mail, Reminders and Calendar**. Six MCP tools expose 42 method behaviors, including diagnostics. Maps and its desktop automation have been removed.

## Origin and maintenance

This project is derived from [supermemoryai/apple-mcp](https://github.com/supermemoryai/apple-mcp), created by [Dhravya Shah](https://github.com/dhravya) and the supermemory team. The upstream repository was archived on January 1, 2026. Apple MCP Plus is an independent repository established for personal use and continued maintenance after that archival.

It retains the original MIT license and copyright notice. See [project origin](PROJECT_ORIGIN.md). Thank you to the original author and upstream contributors for making Apple MCP available as open source.

## Main changes from upstream

This independently maintained version focuses on dependable local queries, explicit permissions and traceable verification:

| Area | Changes in Apple MCP Plus |
| --- | --- |
| Query correctness | Repaired account/mailbox handling, received-date filtering and bounded body search in Mail; added recent-note sorting and folder/date filters; use actual reminder completion states and retain all contact phone numbers. Failures are reported rather than turned into successful empty results. |
| Notes checklists | Added read-only decoding of locally saved native checklist states alongside plaintext task markers. Unreadable states are reported explicitly; the interface does not guess whether an item is checked. |
| Native Reminders / Calendar reads | Added a signed Swift EventKit helper with container enumeration, exact native IDs, completion/date scopes and recurring-event reads. Native reads are selected explicitly; existing create/open methods remain JXA. |
| Permissions and errors | Added `status` / `diagnose` to every tool and explicit EventKit `authorize` methods. Distinguish Automation, EventKit and database readability; report native timeouts/cancellation and avoid automatic backend fallback. |
| Write, open and send handling | Hardened literal text, recipient validation, timezone/all-day event handling and opening the intended item. Message scheduling validates timer limits and documents its process-lifetime requirement; submission is distinguished from delivery. |
| Desktop behavior | Removed Maps, its runtime/schema registration and desktop automation. Remaining runtime paths have no mouse simulation or Accessibility UI control; reminder/calendar opening and Mail sending can still show windows. |
| Testing and maintenance | Added synthetic regressions, Node/Bun MCP inventory checks, native protocol/self-tests, declarative test coverage and opt-in real read-only verification. Established the Apple MCP Plus identity, a reproducible lockfile and bilingual documentation; personal acceptance logs and old bundles stay outside public Git history. |

Current verification and remaining limits are recorded in [VERIFICATION.md](VERIFICATION.md). Native Notes states can be partially unavailable, and lock-screen behavior and all acceptance variants have not been fully verified.

## Tools and methods

Use MCP `tools/list` to discover schemas and `tools/call` to invoke a tool. Most tools select a method with `arguments.operation`. Contacts lists records when `name` is omitted and searches when it is supplied; `list` and `search` are behaviors, not Contacts operation values.

| MCP tool | Query methods | Write / send methods | Open / permission methods | Diagnostics | Behaviors |
| --- | --- | --- | --- | --- | ---: |
| `contacts` | list without `name`; search with `name` | — | — | `status`, `diagnose` | 4 |
| `notes` | `list`, `search`, `todos` | `create` | — | `status`, `diagnose` | 6 |
| `messages` | `read`, `unread` | `send`, `schedule` | — | `status`, `diagnose` | 6 |
| `mail` | `accounts`, `mailboxes`, `latest`, `unread`, `search` | `send` | — | `status`, `diagnose` | 8 |
| `reminders` | `list`, `search`, `listById`, `lists` | `create` | `open`, `authorize` | `status`, `diagnose` | 9 |
| `calendar` | `list`, `search`, `calendars`, `getById` | `create` | `open`, `authorize` | `status`, `diagnose` | 9 |
| **Total** | | | | | **42** |

- **Contacts:** list/search real contact names and all phone numbers; preserve records without numbers and merge duplicate numbers in the formatted display.
- **Notes:** list recent notes; search title and plaintext; filter by folder/date and sort by creation or modification time. `todos` reads unfinished native checklist items and plaintext task markers. `create` writes a note; the compatibility default folder is `Claude`. Only the default `Claude` and `Test-Claude` folders can be automatically created.
- **Messages:** `read` queries a specified conversation; `unread` queries incoming unread messages. `send` submits an iMessage; `schedule` schedules submission in the current process.
- **Mail:** enumerate accounts/mailboxes; read latest/unread messages; search subjects or subjects plus bodies; send text email with optional CC/BCC. Attachment sending and scheduled email are not implemented in the current schema.
- **Reminders:** list/search items, filter actual completion state, read a list by exact ID and optionally project fields. `lists` enumerates native containers with source IDs and writable flags. `create` writes a reminder with notes/due date; `open` shows a matching reminder in the app; `authorize` explicitly requests EventKit access.
- **Calendar:** list/search events by date and calendar; enumerate native calendars; `getById` reads a native event or occurrence. `create` writes ordinary/all-day events with notes/location; `open` displays an event; `authorize` explicitly requests EventKit access.
- **Every tool:** `status` and `diagnose` inspect effective permissions without launching target apps or requesting authorization. Their current implementation returns the same diagnostic payload.

There are no exposed delete, update, checklist-toggle, attachment-send or Maps methods.

## Install and run from source

Requirements: macOS 14+, Node.js, Bun, and Xcode Command Line Tools. The system `osascript` and `sqlite3` executables must be available. This is a local stdio server; Windows/Linux are not supported.

```sh
git clone https://github.com/LennorLv/apple-mcp-plus.git
cd apple-mcp-plus
bun install --frozen-lockfile
npm run build
npm start
```

The build produces `dist/index.js` and an ad-hoc signed EventKit helper for the current Mac architecture. `npm run build:native` rebuilds only the helper. `npm start` waits for MCP requests on stdin; use an MCP client to interact with it. This repository has not been published as an npm package.

Add it to your client's MCP configuration, replacing the paths with absolute paths on your Mac:

```json
{
  "mcpServers": {
    "apple-mcp-plus": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apple-mcp-plus/dist/index.js"]
    }
  }
}
```

Find the Node path with `command -v node`. Restart/reconnect the client after configuration changes. Disable the old `apple-mcp` entry if you intend to use Plus exclusively; the upstream package and old installation bundles do not run this version.

## Permissions and desktop behavior

| Path | Required access / behavior |
| --- | --- |
| Contacts, Notes, Mail; legacy Reminders/Calendar; Messages sends | macOS Automation / Apple Events permission for the target app; configured accounts where needed |
| Messages `read` / `unread` | Read access to the local Messages database, typically through Full Disk Access |
| Notes native checklist state | Automation for note metadata and read access to the local Notes database, typically through Full Disk Access |
| Reminders / Calendar with `backend: "eventkit"` | Separate EventKit full-access authorization, explicitly requested with `authorize` |
| `reminders.open`, `calendar.open` | Activate the app and show the requested item |
| `mail.send` | Creates a visible compose message before sending |

macOS may display the responsible launcher (for example ChatGPT, Codex or Terminal) in an authorization prompt instead of the script filename. Grant access to the actual responsible host. Full Disk Access changes may require restarting that host. Automation and EventKit authorizations are separate.

The runtime has no mouse simulation or Accessibility UI control calls. Diagnostics read `AXIsProcessTrusted` as a permission probe only. Queries use app scripting, local read-only databases or EventKit. Open methods and Mail sending can still bring app windows into view.

Lock-screen behavior has **not** been fully verified. Complete authorization prompts while unlocked. Background reads depend on a logged-in session, a live process, effective permissions and locally available data. Opening UI requires an unlocked desktop. Machine sleep can postpone scheduled work.

## Examples

The following objects are MCP `tools/call` parameters:

```json
{"name":"notes","arguments":{"operation":"list","limit":3,"sortBy":"modificationDate","sortOrder":"desc"}}
{"name":"notes","arguments":{"operation":"todos","limit":10}}
{"name":"mail","arguments":{"operation":"latest","limit":3}}
{"name":"contacts","arguments":{"name":"Example"}}
{"name":"reminders","arguments":{"operation":"list","backend":"eventkit","completed":false,"limit":10}}
{"name":"calendar","arguments":{"operation":"calendars"}}
{"name":"notes","arguments":{"operation":"status"}}
```

For yesterday's invoice emails, supply the actual local-day boundaries with timezones instead of a rolling 24-hour window:

```json
{"name":"mail","arguments":{"operation":"search","searchTerm":"发票","searchIn":"all","fromDate":"2026-10-10T00:00:00+08:00","toDate":"2026-10-11T00:00:00+08:00","mailbox":"inbox","limit":10}}
```

Dates above are examples; substitute the intended day. Mail defaults to the inbox for `latest`/`unread`, and all mailboxes for `search`. Full-body search is bounded to 100 non-subject matches / 10 seconds; narrow mailbox/date scopes if the budget is exceeded.

## EventKit backend and data limits

Existing Reminders/Calendar `list` and `search` calls default to **JXA**. Choose `backend: "eventkit"` explicitly for native reads. `lists`, `calendars`, `getById` and `authorize` are native-only and default to EventKit. Queries never silently request authorization or fall back to another backend.

```json
{"name":"reminders","arguments":{"operation":"authorize","backend":"eventkit"}}
{"name":"calendar","arguments":{"operation":"authorize","backend":"eventkit"}}
{"name":"reminders","arguments":{"operation":"lists"}}
{"name":"reminders","arguments":{"operation":"listById","backend":"eventkit","listId":"EXACT_NATIVE_LIST_ID","limit":10}}
{"name":"calendar","arguments":{"operation":"list","backend":"eventkit","calendarId":"EXACT_NATIVE_CALENDAR_ID","fromDate":"2026-10-11T00:00:00+08:00","toDate":"2026-10-12T00:00:00+08:00","limit":10}}
```

- Returned `idType` distinguishes native and script IDs. **Do not interchange them.** Create/open still use JXA; native write/open requests are rejected.
- Native `getById` requires `occurrenceDate` for recurring instances. Calendar ranges are half-open `[fromDate,toDate)`, include overlapping events and are limited to 366 days under EventKit. Explicit name scopes reject duplicate names; use exact backend IDs where available.
- Query metadata reports backend, completion and truncation. Empty successful results are distinct from permission, timeout and data errors. Helper timeouts cancel outstanding reads; the next explicit call may restart the helper.
- Native Reminders use ID ordering; JXA follows app order. Native `alarmDate` reports the earliest absolute alarm. The legacy `remindMeDate` may fall back to the due date and does not establish that a notification exists.
- Large legacy JXA reminder queries have timed out in local testing. Use explicit EventKit reads for those collections. Do not interpret a timeout as an empty result.
- Notes checklist decoding uses a private on-disk format, reflects locally saved data and may vary between macOS versions. Unsaved edits, locked notes, sync delays or unsupported records can make states unavailable. Review `nativeChecklistStatus` and `unavailableNotes`; zero matches alone does not prove there are no unfinished tasks. Plaintext TODO keywords are unverified.
- Message scheduling is an in-memory timer limited to 24.8 days. Restarting the MCP cancels schedules; sleep can delay them. Submission success does not confirm recipient delivery.

## Verification and development

```sh
npm run build
npm test
npm run test:plan
node_modules/.bin/tsc --noEmit
npm run test:eventkit
```

The default test suite uses synthetic app mocks and real Node/Bun stdio inventory checks. It does not read or modify personal app data. The plan validator checks all 42 behavior cases and 190 required variant items; **plan coverage is not executed functional coverage**.

Run optional real, read-only checks on your own authorized Mac:

```sh
npm run verify:readonly
npm run verify:readonly:bun
```

These query apps and databases without writing, sending, opening items or requesting EventKit authorization. Existing Automation permissions are needed; macOS can otherwise prompt on a query. Optional `APPLE_MCP_TEST_HANDLE` selects a conversation for the `messages.read` check. Results are recorded under ignored `.cache/verification/`, with hashes/counts rather than personal content. Some checks skip when no event/container or test handle exists; incomplete native checklist decoding is recorded as partial.

See [verification evidence](VERIFICATION.md) and [test guidance](TEST_README.md). The current server has been checked locally; this is not a claim that every edge case, every Mac or every lock-screen path has passed. Local real-data acceptance logs and previous Git history are kept outside public commits.

## Acknowledgments and license

Thanks to **Dhravya Shah**, **supermemory**, and all contributors to [the original Apple MCP](https://github.com/supermemoryai/apple-mcp). Their work provided the foundation for this independently maintained project.

[MIT license](LICENSE), retaining the original `Copyright (c) 2025 Dhravya Shah` notice.
