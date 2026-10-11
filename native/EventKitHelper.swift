import Foundation
import EventKit
import ApplicationServices
import CoreServices

struct Failure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

// A timeout can win before fetchReminders returns its cancellation token.
// Late callbacks must never resume a continuation for a second time.
final class CompletionGate<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var cancelled = false
    private var cancellation: (() -> Void)?
    private let completion: (Result<T, Error>) -> Void
    init(_ completion: @escaping (Result<T, Error>) -> Void) { self.completion = completion }
    func installCancellation(_ action: @escaping () -> Void) {
        lock.lock()
        let run = cancelled
        if !finished { cancellation = action }
        lock.unlock()
        if run { action() }
    }
    @discardableResult func finish(_ result: Result<T, Error>, cancel: Bool = false) -> Bool {
        lock.lock()
        if finished { lock.unlock(); return false }
        finished = true; cancelled = cancel
        let action = cancel ? cancellation : nil
        cancellation = nil
        lock.unlock()
        action?(); completion(result)
        return true
    }
}

func iso(_ date: Date?) -> Any {
    guard let date = date else { return NSNull() }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}
func nullableText(_ text: String?) -> Any {
    guard let text, !text.isEmpty else { return NSNull() }
    return text
}
func normalizeAllDayEnd(_ date: Date, allDay: Bool, zone: TimeZone) -> Date {
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
    let parts = calendar.dateComponents([.hour, .minute, .second], from: date)
    if allDay && parts.hour == 23 && parts.minute == 59 && parts.second == 59 {
        return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: date))!
    }
    return date
}
func exclusiveEnd(_ event: EKEvent) -> Date {
    normalizeAllDayEnd(event.endDate, allDay: event.isAllDay, zone: event.timeZone ?? .current)
}
func parseDate(_ value: Any?) throws -> Date {
    guard let text = value as? String else { throw Failure("invalid_arguments", "A timestamp with timezone is required") }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    guard let date = formatter.date(from: text) else { throw Failure("invalid_arguments", "Invalid ISO timestamp") }
    return date
}
func authorization(_ type: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: type) {
    case .notDetermined: return "not_determined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "full_access"
    case .writeOnly: return "write_only"
    @unknown default: return "unknown"
    }
}
func requireAccess(_ type: EKEntityType) throws {
    let state = authorization(type)
    if state != "full_access" { throw Failure("permission_denied", "EventKit access is \(state); use authorize explicitly or grant access in System Settings") }
}
func automation(_ bundleID: String) -> String {
    var target = AEAddressDesc()
    let bytes = Array(bundleID.utf8)
    let created = bytes.withUnsafeBytes { AECreateDesc(DescType(typeApplicationBundleID), $0.baseAddress, bytes.count, &target) }
    guard created == noErr else { return "unknown" }
    defer { AEDisposeDesc(&target) }
    let status = AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
    switch status {
    case noErr: return "granted"
    case -1743: return "denied"
    case -1744: return "not_determined"
    case -600: return "target_not_running"
    default: return "unknown:\(status)"
    }
}

actor Store {
    private let store = EKEventStore()
    func status() -> [String: Any] {
        return ["eventkit": ["reminders": authorization(.reminder), "calendar": authorization(.event)],
                "automation": Dictionary(uniqueKeysWithValues: [
                    ("contacts", "com.apple.AddressBook"), ("notes", "com.apple.Notes"),
                    ("messages", "com.apple.iChat"), ("mail", "com.apple.mail"),
                    ("reminders", "com.apple.reminders"), ("calendar", "com.apple.iCal")
                ].map { ($0.0, automation($0.1)) }),
                "accessibility": AXIsProcessTrusted() ? "granted" : "not_granted",
                "helper": ["bundleIdentifier": Bundle.main.bundleIdentifier ?? "io.apple-mcp.eventkit-helper",
                           "pid": ProcessInfo.processInfo.processIdentifier, "parentPid": getppid(),
                           "osVersion": ProcessInfo.processInfo.operatingSystemVersionString],
                "permissionProbePrompts": false]
    }
    func authorize(_ type: EKEntityType, timeout: Double) async throws -> [String: Any] {
        if authorization(type) == "full_access" { return ["authorization": "full_access"] }
        let granted: Bool = try await withCheckedThrowingContinuation { continuation in
            let gate = CompletionGate<Bool> { continuation.resume(with: $0) }
            let timer = DispatchWorkItem { gate.finish(.failure(Failure("timeout", "EventKit authorization timed out")), cancel: true) }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
            let callback: @Sendable (Bool, Error?) -> Void = { granted, error in
                timer.cancel()
                if error != nil { gate.finish(.failure(Failure("permission_denied", "EventKit authorization failed"))) }
                else { gate.finish(.success(granted)) }
            }
            if type == .reminder { store.requestFullAccessToReminders(completion: callback) }
            else { store.requestFullAccessToEvents(completion: callback) }
        }
        guard granted else { throw Failure("permission_denied", "EventKit access was not granted") }
        store.reset()
        return ["authorization": authorization(type)]
    }
    func containers(_ type: EKEntityType, _ p: [String: Any]) throws -> [EKCalendar] {
        var calendars = store.calendars(for: type)
        let key = type == .reminder ? "listId" : "calendarId"
        if let id = p[key] as? String {
            calendars = calendars.filter { $0.calendarIdentifier == id }
            if calendars.isEmpty { throw Failure("not_found", "Container ID not found for this backend") }
        }
        if let ids = p["calendarIds"] as? [String] {
            if Set(ids).subtracting(calendars.map { $0.calendarIdentifier }).count > 0 { throw Failure("not_found", "One or more calendar IDs were not found") }
            calendars = calendars.filter { ids.contains($0.calendarIdentifier) }
        }
        let nameKey = type == .reminder ? "listName" : "calendarName"
        if let name = p[nameKey] as? String {
            calendars = calendars.filter { $0.title == name }
            if calendars.isEmpty { throw Failure("not_found", "Container name not found") }
            if calendars.count > 1 { throw Failure("ambiguous_target", "Container name is ambiguous; select an exact ID") }
        }
        return calendars
    }
    func containerRow(_ c: EKCalendar) -> [String: Any] {
        ["id": c.calendarIdentifier, "idType": "eventkit-calendar", "name": c.title,
         "sourceId": c.source.sourceIdentifier, "sourceName": c.source.title,
         "writable": c.allowsContentModifications]
    }
    func fetch(_ calendars: [EKCalendar], timeout: Double) async throws -> [EKReminder] {
        if calendars.isEmpty { return [] }
        return try await withCheckedThrowingContinuation { continuation in
            let gate = CompletionGate<[EKReminder]> { continuation.resume(with: $0) }
            let timer = DispatchWorkItem { gate.finish(.failure(Failure("timeout", "EventKit reminder fetch timed out")), cancel: true) }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
            let token = store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { reminders in
                timer.cancel()
                guard let reminders = reminders else {
                    gate.finish(.failure(Failure("data_unavailable", "EventKit returned no reminder snapshot"))); return
                }
                gate.finish(.success(reminders))
            }
            gate.installCancellation { Task { self.cancelFetch(token) } }
        }
    }
    private func cancelFetch(_ token: Any) { store.cancelFetchRequest(token) }
    func reminderRow(_ r: EKReminder) throws -> [String: Any] {
        guard let c = r.calendar else { throw Failure("data_unavailable", "Reminder has no calendar; snapshot is incomplete") }
        var date: Date?
        if let components = r.dueDateComponents {
            date = (components.calendar ?? Calendar.current).date(from: components)
            if date == nil { throw Failure("data_unavailable", "Reminder due date cannot be decoded") }
        }
        let absoluteAlarms = (r.alarms ?? []).compactMap { $0.absoluteDate }.sorted()
        return ["id": r.calendarItemIdentifier, "idType": "eventkit-reminder",
                "externalId": r.calendarItemExternalIdentifier ?? NSNull() as Any,
                "name": r.title ?? "", "body": r.notes ?? "", "completed": r.isCompleted,
                "dueDate": iso(date), "dueDateIsDateOnly": r.dueDateComponents.map { $0.hour == nil } ?? false,
                "listName": c.title, "listId": c.calendarIdentifier,
                "creationDate": iso(r.creationDate), "modificationDate": iso(r.lastModifiedDate),
                // Legacy Reminders exposes a due date as remindMeDate even without an alarm.
                // Keep that compatibility field separate from the actual absolute alarm.
                "completionDate": iso(r.completionDate), "remindMeDate": iso(absoluteAlarms.first ?? date),
                "alarmDate": iso(absoluteAlarms.first), "priority": r.priority]
    }
    func eventRow(_ e: EKEvent) throws -> [String: Any] {
        guard let id = e.eventIdentifier, let c = e.calendar, let start = e.startDate, let end = e.endDate else {
            throw Failure("data_unavailable", "Event snapshot is incomplete")
        }
        return ["id": id, "idType": "eventkit-event", "calendarItemId": e.calendarItemIdentifier,
                "externalId": e.calendarItemExternalIdentifier ?? NSNull() as Any,
                "title": e.title ?? "", "location": nullableText(e.location),
                "notes": nullableText(e.notes), "startDate": iso(start), "endDate": iso(normalizeAllDayEnd(end, allDay: e.isAllDay, zone: e.timeZone ?? .current)),
                "calendarName": c.title, "calendarId": c.calendarIdentifier, "isAllDay": e.isAllDay,
                "url": e.url?.absoluteString ?? NSNull() as Any, "isRecurring": e.hasRecurrenceRules,
                "isDetached": e.isDetached, "occurrenceDate": iso(e.occurrenceDate),
                "timeZone": e.timeZone?.identifier ?? NSNull() as Any]
    }
    func run(_ op: String, _ p: [String: Any], timeout: Double) async throws -> [String: Any] {
        if op == "status" { return status() }
        let reminder = op.hasPrefix("reminders.")
        let type: EKEntityType = reminder ? .reminder : .event
        guard reminder || op.hasPrefix("calendar.") else { throw Failure("unsupported", "Unsupported helper operation") }
        if op.hasSuffix(".authorize") { return try await authorize(type, timeout: timeout) }
        try requireAccess(type)
        // Each request obtains a fresh snapshot; no stale query cache after external edits.
        store.reset()
        let calendars = try containers(type, p)
        if op.hasSuffix(".containers") { return ["containers": calendars.map(containerRow)] }
        let limit = p["limit"] as? Int ?? (reminder ? 50 : 10)
        guard (1...100).contains(limit) else { throw Failure("invalid_arguments", "limit must be between 1 and 100") }
        if reminder {
            guard op == "reminders.query" else { throw Failure("unsupported", "Unsupported reminder operation") }
            let term = (p["searchText"] as? String ?? "").lowercased()
            let completed = p["completed"] as? Bool
            let rows = try await fetch(calendars, timeout: timeout).filter { r in
                (completed == nil || r.isCompleted == completed!) &&
                (term.isEmpty || (r.title ?? "").lowercased().contains(term) || (r.notes ?? "").lowercased().contains(term))
            }.map(reminderRow).sorted { ($0["id"] as! String) < ($1["id"] as! String) }
            return ["lists": calendars.map(containerRow), "reminders": Array(rows.prefix(limit)),
                    "meta": meta(total: rows.count, limit: limit)]
        }
        if op == "calendar.getById" {
            guard let id = p["eventId"] as? String, let event = store.event(withIdentifier: id), event.eventIdentifier == id else {
                throw Failure("not_found", "EventKit event ID not found")
            }
            guard calendars.contains(where: { $0.calendarIdentifier == event.calendar.calendarIdentifier }) else { throw Failure("not_found", "Event is outside the selected calendars") }
            if let occurrence = p["occurrenceDate"] {
                let date = try parseDate(occurrence)
                let candidates = store.events(matching: store.predicateForEvents(withStart: date.addingTimeInterval(-1), end: date.addingTimeInterval(1), calendars: [event.calendar]))
                let matched = candidates.filter { $0.eventIdentifier == id && $0.occurrenceDate == date }
                guard matched.count == 1 else { throw Failure("not_found", "Exact event occurrence not found") }
                return ["event": try eventRow(matched[0])]
            }
            if event.hasRecurrenceRules { throw Failure("invalid_arguments", "occurrenceDate is required for recurring event lookup") }
            return ["event": try eventRow(event)]
        }
        guard op == "calendar.query" else { throw Failure("unsupported", "Unsupported calendar operation") }
        let from = try parseDate(p["fromDate"]), to = try parseDate(p["toDate"])
        guard from < to, to.timeIntervalSince(from) <= 366 * 86400 else {
            throw Failure("invalid_arguments", "Date range must be increasing and at most 366 days")
        }
        let term = (p["searchText"] as? String ?? "").lowercased()
        let events = calendars.isEmpty ? [] : store.events(matching: store.predicateForEvents(withStart: from.addingTimeInterval(-1), end: to, calendars: calendars))
        let rows = try events.filter { e in
            e.startDate < to && exclusiveEnd(e) > from && (term.isEmpty || [e.title ?? "", e.location ?? "", e.notes ?? ""].joined(separator: "\n").lowercased().contains(term))
        }.map(eventRow).sorted { a, b in
            if (a["startDate"] as! String) != (b["startDate"] as! String) { return (a["startDate"] as! String) < (b["startDate"] as! String) }
            return (a["id"] as! String) < (b["id"] as! String)
        }
        return ["events": Array(rows.prefix(limit)), "meta": meta(total: rows.count, limit: limit)]
    }
    private func meta(total: Int, limit: Int) -> [String: Any] {
        ["backend": "eventkit", "totalMatched": total, "returned": min(total, limit),
         "complete": total <= limit, "truncated": total > limit,
         "ordering": "reminders: eventkit-id ascending; events: startDate then eventkit-id ascending"]
    }
}

@main struct Main {
    static func main() async {
        if CommandLine.arguments.contains("--self-test") {
            var results = 0, cancellations = 0
            let gate = CompletionGate<Int> { _ in results += 1 }
            precondition(gate.finish(.failure(Failure("timeout", "test")), cancel: true))
            gate.installCancellation { cancellations += 1 }
            precondition(!gate.finish(.success(1)))
            precondition(results == 1 && cancellations == 1)
            let early = CompletionGate<Int> { _ in results += 1 }
            early.installCancellation { cancellations += 1 }
            precondition(early.finish(.success(1)))
            precondition(!early.finish(.failure(Failure("timeout", "late")), cancel: true))
            precondition(results == 2 && cancellations == 1)
            let race = CompletionGate<Int> { _ in results += 1 }
            DispatchQueue.concurrentPerform(iterations: 1000) { index in
                race.finish(.success(index), cancel: index % 2 == 0)
            }
            precondition(results == 3)
            let utc = TimeZone(secondsFromGMT: 0)!
            let inclusive = try! parseDate("2035-07-02T23:59:59.999Z")
            let midnight = try! parseDate("2035-07-03T00:00:00Z")
            precondition(normalizeAllDayEnd(inclusive, allDay: true, zone: utc) == midnight)
            precondition(normalizeAllDayEnd(inclusive, allDay: false, zone: utc) == inclusive)
            precondition(normalizeAllDayEnd(midnight, allDay: true, zone: utc) == midnight)
            print("{\"selfTest\":\"PASS\",\"cases\":4}"); return
        }
        let store = Store()
        // Sequential NDJSON requests share one actor/store. EOF exits cleanly.
        while let line = readLine() {
            var requestId = "invalid"
            var response: [String: Any]
            do {
                guard let data = line.data(using: .utf8), let p = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = p["requestId"] as? String, let op = p["operation"] as? String else {
                    throw Failure("invalid_arguments", "Expected an NDJSON request with requestId and operation")
                }
                requestId = id
                let timeout = min(max(p["timeoutMs"] as? Double ?? 30000, 1), 60000) / 1000
                let result = try await store.run(op, p["parameters"] as? [String: Any] ?? [:], timeout: timeout)
                response = ["requestId": id, "success": true, "result": result]
            } catch {
                let failure = error as? Failure ?? Failure("internal_error", "EventKit request failed")
                response = ["requestId": requestId, "success": false, "error": ["code": failure.code, "message": failure.message]]
            }
            do {
                let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
                FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
            } catch { exit(1) }
        }
    }
}
