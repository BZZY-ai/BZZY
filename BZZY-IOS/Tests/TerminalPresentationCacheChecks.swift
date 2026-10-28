import Foundation

@main
struct TerminalPresentationCacheChecks {
    @MainActor static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-presentation-tests-\(UUID())", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadata = TerminalPresentationMetadata(title: "Synthetic terminal", hasAlias: true,
            provider: "Fixture", model: "Fixture model", directory: "/synthetic/project")
        let session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let scope = TerminalPresentationScope(hostID: "host-one", resource: "session:\(session)", sessionID: session, authorizationID: "grant-one")
        let cache = TerminalPresentationCache(directory: directory)
        let messages = (1...225).map { message($0) }
        let saved = try cache.save(scope: scope, metadata: metadata, messages: messages, now: Date(timeIntervalSince1970: 123))
        require(saved.messages == Array(messages.suffix(100)), "Cache must retain the latest100 complete stable messages")
        require(saved.omittedMessageCount == 0 && saved.savedAt == Date(timeIntervalSince1970: 123), "Normal bounds must keep an honest saved date and omission count")
        require(cache.load(scope: scope) == saved, "Exact transcript bodies and attribution must survive relaunch")
        let sameHostOtherGrant = TerminalPresentationScope(hostID: scope.hostID, resource: scope.resource, sessionID: session, authorizationID: "grant-two")
        let sameGrantOtherHost = TerminalPresentationScope(hostID: "host-two", resource: scope.resource, sessionID: session, authorizationID: scope.authorizationID)
        let sameSessionOtherResource = TerminalPresentationScope(hostID: scope.hostID, resource: "other-resource", sessionID: session, authorizationID: scope.authorizationID)
        require(cache.load(scope: sameHostOtherGrant) == nil && cache.load(scope: sameGrantOtherHost) == nil && cache.load(scope: sameSessionOtherResource) == nil,
            "Host, grant and resource must isolate even identical session IDs")

        let rich = LocalMessage(id: UUID(), text: "<message version=\"1\"><p>Exact 👁️ &amp; text.</p><pre language=\"sh\">printf 'hello'\n</pre></message>",
            kind: .assistant, createdAt: Date(timeIntervalSince1970: 125), speaker: "Agent · Synthetic", accentIndex: 7)
        let invocation = LocalMessage(id: UUID(), text: "", kind: .invocation, createdAt: Date(timeIntervalSince1970: 126),
            invocation: .init(id: "synthetic-invocation", kind: .agent, name: "Synthetic checker", state: "accepted", round: 2, sequence: 9, accentIndex: 7))
        let huge = LocalMessage(id: UUID(), text: String(repeating: "💾", count: TerminalPresentationCache.maximumMessageBytes), kind: .assistant, createdAt: Date())
        let bounded = try cache.save(scope: scope, metadata: metadata, messages: [rich, huge, invocation])
        require(bounded.messages == [rich, invocation] && bounded.omittedMessageCount == 1,
            "Oversize entries must be explicitly omitted whole without truncating rich content or invocation metadata")
        let withinEntryBudget = (1...12).map { index in message(index, text: String(repeating: "a", count: 110_000)) }
        let boundedByFile = try cache.save(scope: scope, metadata: metadata, messages: withinEntryBudget)
        require(boundedByFile.messages.count < withinEntryBudget.count && boundedByFile.messages.last == withinEntryBudget.last,
            "The session byte budget must favor the newest complete messages")
        require(boundedByFile.messages.count + boundedByFile.omittedMessageCount == withinEntryBudget.count, "Every budget exclusion must be disclosed")
        let files = jsonFiles(directory)
        require(files.count == 1, "Atomic replacement must leave one scoped presentation file")
        let file = files[0]
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        require((attributes[.size] as? NSNumber)?.intValue ?? Int.max <= TerminalPresentationCache.maximumSessionBytes, "Encoded files must fit the byte limit")
        require((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "Private transcript files must have owner-only permissions")
        try require(file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true, "Private display caches must not enter backups")

        // Tampering cannot cross scopes just by copying a file to another scope's location.
        try cache.save(scope: sameHostOtherGrant, metadata: metadata, messages: [message(1)])
        let otherFile = jsonFiles(directory).first { $0 != file }!
        let original = try Data(contentsOf: file)
        try original.write(to: otherFile, options: .atomic)
        require(cache.load(scope: sameHostOtherGrant) == nil, "The encoded identity must match the requested identity")
        try Data("{malformed".utf8).write(to: file, options: .atomic)
        require(cache.load(scope: scope) == nil, "Corrupt optional caches must fail closed without breaking a session")
        try Data(repeating: 32, count: TerminalPresentationCache.maximumSessionBytes + 1).write(to: file, options: .atomic)
        require(cache.load(scope: scope) == nil, "Decode must reject oversized files before allocation")
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: otherFile)
        require(cache.load(scope: scope) == nil, "Presentation reads must not follow symbolic file links")
        cache.remove(hostID: scope.hostID)
        require(jsonFiles(directory).isEmpty, "Unpair or host revocation must remove all grants and transcripts for that host")

        try cache.save(scope: scope, metadata: metadata, messages: [rich, invocation])
        let store = WorkspaceStore(includeSamples: false, presentationCacheDirectory: directory)
        store.setLiveAvailability(true, status: "Previous live connection")
        require(store.restoreCachedPresentation(scope: scope), "A fresh workspace must show cached rows before network attachment")
        require(store.liveMessages == [rich, invocation] && store.isPresentingCachedHistory, "Fast preview must preserve real message identities and original bodies")
        require(!store.liveAvailable && store.liveSession?.permissions == [] && store.liveSession?.questions == []
            && store.liveSession?.inputOwner == nil && store.liveSession?.goalStatus == nil && store.liveSession?.activeSteering == false,
            "Saved text must never restore authority, actions, pending questions or input ownership")
        let snapshot: [String: Any] = ["session": ["id": session, "alias": "Fresh alias", "provider": "Fixture", "model": "Fixture model"],
            "capabilities": ["permissions": ["observe"]]]
        store.applyLiveSnapshot(try JSONSerialization.data(withJSONObject: snapshot))
        require(store.liveMessages == [rich, invocation], "Authoritative metadata refresh must keep cached text visible until replay is ready")
        let toolOnly: [String: Any] = ["sessionId": session, "id": "tool-only-event", "seq": 1, "type": "tool", "createdAt": "2026-10-27T12:00:00Z", "data": ["name": "fixture"]]
        store.applyLiveEvents([try JSONSerialization.data(withJSONObject: toolOnly)])
        store.cacheLivePresentation(scope: scope)
        require(store.liveMessages == [rich, invocation] && store.isPresentingCachedHistory && cache.load(scope: scope)?.messages == [rich, invocation],
            "Tool-only partial hydration must preserve cached transcript rows and never overwrite the saved tail as empty")
        let event: [String: Any] = ["sessionId": session, "id": "fresh-event", "seq": 1, "type": "text", "createdAt": "2026-10-27T12:00:00Z", "data": ["text": "Fresh canonical reply"]]
        store.applyLiveEvents([try JSONSerialization.data(withJSONObject: event)])
        require(!store.isPresentingCachedHistory && store.liveMessages.count == 1 && store.liveMessages[0].text == "Fresh canonical reply",
            "Replay must replace the provisional projection without duplicate rows")
        store.cacheLivePresentation(scope: scope)
        let relaunched = WorkspaceStore(includeSamples: false, presentationCacheDirectory: directory)
        require(relaunched.restoreCachedPresentation(scope: scope) && relaunched.liveMessages == store.liveMessages,
            "A subsequently projected live tail must become the next immediate preview")
        store.removeCachedPresentation(hostID: scope.hostID, authorizationID: scope.authorizationID, sessionID: session)
        require(!WorkspaceStore(includeSamples: false, presentationCacheDirectory: directory).restoreCachedPresentation(scope: scope),
            "A confirmed terminal deletion must remove its cached transcript")

        // Disk cost is bounded across old computers and terminals, with least recently used eviction.
        let large = (1...8).map { message($0, text: String(repeating: "b", count: 110_000)) }
        for index in 0..<21 {
            let item = TerminalPresentationScope(hostID: "budget-host-\(index)", resource: scope.resource, sessionID: session, authorizationID: "grant")
            try cache.save(scope: item, metadata: metadata, messages: large)
        }
        var total = try jsonFiles(directory).reduce(0) { $0 + (try Data(contentsOf: $1)).count }
        require(total <= TerminalPresentationCache.maximumTotalBytes, "All private display caches together must stay within16MiB")
        require(cache.load(scope: .init(hostID: "budget-host-0", resource: scope.resource, sessionID: session, authorizationID: "grant")) == nil,
            "Eviction must discard the least recently used older transcript")
        cache.retainHosts([])
        for index in 0..<35 {
            try cache.save(scope: .init(hostID: "small-host-\(index)", resource: scope.resource, sessionID: session, authorizationID: "grant"), metadata: metadata, messages: [message(1)])
        }
        total = jsonFiles(directory).count
        require(total <= TerminalPresentationCache.maximumSessions, "Tiny old transcripts must also obey the session count bound")
        cache.retainHosts(["small-host-34"])
        require(jsonFiles(directory).count == 1, "Saved-computer cleanup must retain only the selected authorized host set")
        print("Terminal presentation cache checks passed")
    }

    private static func message(_ index: Int, text: String? = nil) -> LocalMessage {
        LocalMessage(id: UUID(uuidString: String(format: "30000000-0000-4000-8000-%012d", index))!,
            text: text ?? "Original body \(index)", kind: index.isMultiple(of: 2) ? .assistant : .user,
            createdAt: Date(timeIntervalSince1970: Double(index)), speaker: index.isMultiple(of: 2) ? "Main" : nil)
    }

    private static func jsonFiles(_ directory: URL) -> [URL] {
        let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
        return enumerator?.compactMap { ($0 as? URL).flatMap { $0.pathExtension == "json" ? $0 : nil } } ?? []
    }

    private static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) rethrows {
        if try !condition() { fatalError(message) }
    }
}
