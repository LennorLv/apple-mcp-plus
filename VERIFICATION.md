# Verification evidence

[English](VERIFICATION.md) · [简体中文](VERIFICATION.zh-CN.md)

Checked on October 11, 2026, on one authorized macOS 27.0 arm64 machine with Node.js 24.21.0 and Bun 1.4.3. The minimum supported build target is macOS 14; older supported versions and other machines were not exercised in this run.

## Reproducible build and synthetic regression

A separate directory containing only public source was installed with `bun install --frozen-lockfile --ignore-scripts`. Its build, test suite, type check, plan check and native self-tests all passed.

| Check | Actual result | What it establishes |
| --- | --- | --- |
| Frozen dependency install | PASS | Fresh install from the committed lockfile |
| Node bundle + signed native helper build | PASS | Source builds on the tested Mac |
| Default regressions | 36 PASS, 0 FAIL, 175 assertions | Synthetic query/write/open/send logic, checklist decoding and helper protocol |
| Real stdio inventory, Node and Bun | PASS | Six registered tools; all nine removed Maps operations rejected in each runtime |
| TypeScript `--noEmit` | PASS | Runtime and test types compile |
| Native helper `--self-test` | 4 PASS | Internal helper semantics without app data |
| Plan validator | 42 behaviors, 190 required variant items | Design completeness only; zero functional tests executed by this command |

The working dependency tree was aligned with the fresh frozen installation after an initial check found it differed from the lockfile. Frozen versions include MCP SDK 1.5.0, JXA 1.3.6, Zod 3.24.2 and TypeScript 5.7.3. Real-read checks were performed again using the frozen versions.

## Real MCP reads

The SDK connected over stdio, checked initialization/ping and the tool catalog, then called all six tools' `status` and `diagnose` methods and the reads below. These checks never wrote data, sent anything, opened items or requested EventKit authorization.

| Tool | Executed real methods | Result |
| --- | --- | --- |
| Contacts | list, search, status, diagnose | PASS |
| Notes | list (latest three, sorted), search, todos, status, diagnose | PASS except partial native checklist availability in todos |
| Messages | read of a controlled conversation, unread, status, diagnose | PASS |
| Mail | accounts, mailboxes, latest, unread, subject search, status, diagnose | PASS |
| Reminders | native lists/list/search/listById, default JXA list, status, diagnose | PASS |
| Calendar | native calendars/list/search/getById, default JXA list, status, diagnose | PASS |

Each frozen runtime check produced **35 PASS, 1 PARTIAL, 0 FAIL, 0 SKIP**. PASS confirms successful calls and the script's assertions; an empty search is a valid successful empty branch, not a positive-match test for every feature.

The PARTIAL result is `notes.todos`: some local note data was missing, locked or not locally synced according to the reader. The database was readable and other records decoded; the exact cause for the unavailable record was not resolved. The service returned `nativeChecklistStatus: "partial"` instead of guessing the check state. This is a documented data-availability boundary, not a full pass for every native checklist.

Earlier local acceptance runs included controlled note/reminder/calendar creation and opening, email receipt and immediate/scheduled iMessage delivery. Those historical records are retained privately. Writes, UI opening and delivery were **not rerun during this publication check**, and those earlier results do not certify every operation on the frozen public build.

## Remaining limits

- The 190 design variants have not all been executed. Permission denial, unusual account configurations, synchronization races, recurrence exceptions and other edge cases need further acceptance coverage.
- Lock-screen operation has not been certified. Opening UI and handling authorization prompts require an unlocked desktop.
- Large JXA reminder collections have timed out in earlier local testing; EventKit is available explicitly for reads. This publication run used bounded JXA reads, not a fresh stress test.
- Notes' private database format and locally available snapshots can differ across OS versions; unavailable states remain explicit.
- A granted permission or a submitted send is not proof of account health, synchronization or delivery.

## Reproduce and trace

Commands are documented in [TEST_README.md](TEST_README.md). Read-only records remain under ignored `.cache/verification/`. Public evidence contains only test IDs/statuses and source fingerprints; no personal records, addresses, recipient IDs or app contents are published. The old local Git history and real-data acceptance logs were preserved privately before creating the clean public source history.

Runtime source SHA-256: `4c567b4215c75fc56f9e3ce2aa3a87fd843224f1c66765e9a8abb965d4a6b7bd`. The digest concatenates `filename + "\n" + UTF-8 source + "\n"`, in order: `index.ts`, `tools.ts`, all `utils/*.ts` sorted by filename, `native/EventKitHelper.swift`, `native/Info.plist`. Dependency versions, platform and runtime remain separate prerequisites.

The six-tool MCP service is usable on the tested, authorized machine. This evidence does not claim universal compatibility or complete acceptance of all 42 behaviors and their edge cases.

[Machine-readable summary / 机器可读摘要](verification/2026-10-11.json)
