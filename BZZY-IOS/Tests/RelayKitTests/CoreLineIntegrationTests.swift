import XCTest
@testable import RelayKit

/// Uses the same URLSession transport, cryptography and Core client as the app.
/// The host and Relay are actual Node implementations with a disposable model.
final class CoreLineIntegrationTests: XCTestCase {
    @MainActor func testLocalEndpointCannotDisableProductionTrust() throws {
        let identity = try RelayIdentity.generate()
        for endpoint in ["ws://example.com:1234/v1/socket", "ws://localhost:1234/v1/socket",
                         "ws://127.0.0.1:1234/wrong", "ws://127.0.0.1:1234/v1/socket?code=bad",
                         "ws://user@127.0.0.1:1234/v1/socket", "wss://example.com/v1/socket"] {
            XCTAssertThrowsError(try RelayTransport(identity: identity, loopbackEndpoint: XCTUnwrap(URL(string: endpoint))))
        }
    }

    @MainActor func testNativeCoreRelayLinePairExecuteReplayControlTaskAndRevoke() async throws {
        var phase = "fixture setup"
        defer { print("Native Core line final phase: \(phase)") }
        do {
        let fixture = try LocalCoreLineFixture()
        defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "certificate": try RelayWire.object(identity.certificate)])
        let endpoint = try XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string)))
        let transport = try RelayTransport(identity: identity, loopbackEndpoint: endpoint)
        defer { transport.disconnect() }
        let host = try RelayCertificate.parse(configuration["host"])
        try transport.trust(host)
        let role = try await transport.connect()
        XCTAssertEqual(role, "candidate")
        var clients: [String: CoreRelayClient] = [:], payloadErrors: [String] = []
        transport.onPayload = { from, grant, payload in
            for value in clients.values where value.grantID == grant {
                if let resource = payload["resource"].string, resource != value.resource { continue }
                do { try value.receive(from: from, grantID: grant, payload: payload) }
                catch { payloadErrors.append((error as? CoreApplicationError)?.code ?? "INVALID_PAYLOAD") }
            }
        }

        func pair(_ invitation: WireValue) async throws -> (CoreRelayClient, WireValue) {
            let claim = try await transport.request("invite.claim", fields: ["code": invitation["code"]])
            let claimID = try XCTUnwrap(claim["claimId"].string)
            let decision = try await eventually {
                let value = try await transport.request("invite.status", fields: ["claimId": .string(claimID)])
                return value["state"].string == "approved" ? value : nil
            }
            let grant = decision["grant"], id = try XCTUnwrap(grant["id"].string)
            XCTAssertEqual(grant["hostId"].string, host.id)
            XCTAssertEqual(grant["recipientId"].string, identity.certificate.id)
            XCTAssertEqual(try RelayCertificate.parse(grant["peer"]), host)
            let inspected = try await transport.inspect(id)
            let client = CoreRelayClient(transport: transport, hostID: host.id, grantID: id,
                                         resource: try XCTUnwrap(inspected["spec"]["resource"].string))
            clients[client.resource] = client
            return (client, grant)
        }

        let (client, grant) = try await pair(configuration["direct"])
        let (observer, _) = try await pair(configuration["observer"])
        let (coordinator, _) = try await pair(configuration["task"])
        phase = "catalog and observer authorization"
        let detached = try fixture.request(["op": .string("detach")])
        XCTAssertEqual(detached["ready"].bool, true, "Closing the CLI Settings adapter must leave Core's gateway running")
        XCTAssertEqual(detached["managed"].bool, true)
        let snapshot = try await client.request("session.get")
        XCTAssertEqual(snapshot["session"]["id"].string, configuration["sessionId"].string)
        XCTAssertEqual(snapshot["session"]["model"].string, "fixture-model")
        XCTAssertEqual(snapshot["capabilities"]["portableSharing"].bool, false)
        XCTAssertEqual(snapshot["capabilities"]["sessionAccess"].bool, true)
        let catalog = try await client.request("sessions.list", params: ["limit": .number(25)])
        XCTAssertTrue(catalog["sessions"].array?.contains { $0["id"].string == configuration["otherSessionId"].string && $0["cwd"].string != nil } == true)
        let openID = CoreRelayClient.commandID(), openInput: [String: CoreJSONValue] = ["sessionId": .string(try XCTUnwrap(configuration["otherSessionId"].string))]
        let opened = try await client.request("sessions.open", params: openInput, id: openID)
        let openedAgain = try await client.request("sessions.open", params: openInput, id: openID)
        XCTAssertEqual(opened["resource"], openedAgain["resource"])
        let secondaryResource = try XCTUnwrap(opened["resource"].string)
        XCTAssertNotEqual(secondaryResource, client.resource)
        let secondary = CoreRelayClient(transport: transport, hostID: host.id, grantID: client.grantID, resource: secondaryResource)
        clients[secondary.resource] = secondary
        let secondarySnapshot = try await secondary.request("session.get")
        XCTAssertEqual(secondarySnapshot["session"]["id"].string, configuration["otherSessionId"].string)
        XCTAssertEqual(secondarySnapshot["capabilities"]["sessionAccess"].bool, false)
        XCTAssertEqual(client.sessionID, configuration["sessionId"].string, "Catalog attachment must not rebind the original client")
        let wrongScope = CoreRelayClient(transport: transport, hostID: host.id, grantID: client.grantID,
            resource: try XCTUnwrap(configuration["otherSessionId"].string))
        clients[wrongScope.resource] = wrongScope
        do { _ = try await wrongScope.request("session.get"); XCTFail("A device grant must not cross resources") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        clients.removeValue(forKey: wrongScope.resource)
        XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 0,
                       "Pairing and observing must never execute a model")
        _ = try await observer.request("session.get")
        let metrics = try CoreHostMetrics(try await observer.request("host.metrics"))
        XCTAssertGreaterThan(metrics.memoryTotalBytes, 0)
        XCTAssertGreaterThan(metrics.coreRSSBytes, 0)
        XCTAssertLessThanOrEqual(metrics.memoryUsedBytes, metrics.memoryTotalBytes)
        do { _ = try await observer.request("sessions.list"); XCTFail("A session-only observer cannot discover terminals") }
        catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }
        do {
            _ = try await observer.request("input.claim", params: ["owner": .string("observer")])
            XCTFail("An observer cannot acquire control")
        } catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "FORBIDDEN") }

        let owner = "line-phone"
        phase = "first execution and idempotent acceptance"
        let firstLease = try await client.request("input.claim", params: ["owner": .string(owner)])
        let renewedLease = try await client.request("input.claim", params: ["owner": .string(owner)])
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(renewedLease["expiresAt"].integer), try XCTUnwrap(firstLease["expiresAt"].integer))
        let command = CoreRelayClient.commandID()
        let input: [String: CoreJSONValue] = ["owner": .string(owner), "prompt": .string("LINE_NATIVE_PRIVATE_PROMPT")]
        let execution = try await client.request("execution.execute", params: input, id: command)
        let repeated = try await client.request("execution.execute", params: input, id: command)
        XCTAssertEqual(execution["executionId"], repeated["executionId"])
        let finished = try await eventually("first execution completion") {
            let state = try fixture.request(["op": .string("state")])
            return state["executions"].array?.contains(where: { $0["id"].string == execution["executionId"].string && $0["state"].string == "finished" }) == true ? state : nil
        }
        XCTAssertEqual(finished["executionCount"].integer, 1)
        XCTAssertEqual(finished["plaintextLeak"].bool, false)
        XCTAssertEqual(finished["terminalRendersBody"].bool, true, "The actual TUI renderer consumes the canonical body from Core history")
        let accepted = try await client.request("command.status", params: ["requestId": .string(command)])
        XCTAssertEqual(accepted["state"].string, "accepted")

        let projectionDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("bzzy-line-projection-" + UUID().uuidString)
        phase = "durable event projection"
        defer { try? FileManager.default.removeItem(at: projectionDirectory) }
        let projection = try CoreEventProjectionStore(directory: projectionDirectory, hostID: host.id,
            resource: client.resource, sessionID: try XCTUnwrap(snapshot["session"]["id"].string))
        var batches: [CoreEventBatch] = []
        client.onEvents = { batches.append($0) }
        _ = try await client.request("events.subscribe", params: ["consumerId": .string(projection.consumerID)])
        let initial = try await eventually("initial event batch") { batches.first }
        try projection.apply(initial)
        let raw = projection.events.filter { $0.type == "text" }.compactMap { $0.data["text"].string }.joined()
        XCTAssertEqual(raw, "<message version=\"1\"><h2>Line check</h2><p><b>Offline result</b> <span color=\"mint\">ready</span></p><ul><li>One shared execution</li></ul></message>")
        _ = try await client.request("events.ack", params: ["subscriptionId": .string(initial.subscriptionId), "seq": .number(Double(initial.nextCursor))])
        let savedCursor = projection.cursor

        // Both network suspension and host gateway restart retain one execution.
        phase = "daemon restart and replay"
        for value in clients.values { value.disconnected() }
        clients.removeAll()
        transport.disconnect()
        let restarted = try fixture.request(["op": .string("restart")])
        XCTAssertEqual(restarted["ready"].bool, true)
        XCTAssertEqual(restarted["restarted"].bool, true, "The Core daemon, not only its Relay socket, was restarted")
        let tail = try fixture.request(["op": .string("append")])
        _ = try await transport.connect()
        let restored = CoreRelayClient(transport: transport, hostID: host.id, grantID: client.grantID, resource: client.resource)
        clients[restored.resource] = restored
        _ = try await restored.request("session.get")
        let restoredCatalog = try await restored.request("sessions.list")
        XCTAssertEqual(restoredCatalog["sessions"].array?.first { $0["id"].string == configuration["otherSessionId"].string }?["existingResource"].string, secondaryResource)
        let secondaryRestored = CoreRelayClient(transport: transport, hostID: host.id, grantID: restored.grantID, resource: secondaryResource)
        clients[secondaryResource] = secondaryRestored
        _ = try await secondaryRestored.request("session.get")
        var replay: [CoreEventBatch] = []
        restored.onEvents = { replay.append($0) }
        let subscription = try await restored.request("events.subscribe", params: ["consumerId": .string(projection.consumerID)])
        XCTAssertEqual(subscription["processedCursor"].integer, savedCursor)
        let replayed = try await eventually("replayed event batch") { replay.first }
        XCTAssertTrue(replayed.events.allSatisfy { $0.seq > savedCursor })
        XCTAssertTrue(replayed.events.contains { $0.id == tail["id"].string })
        try projection.apply(replayed); try projection.apply(replayed)
        XCTAssertEqual(Set(projection.events.map(\.id)).count, projection.events.count)
        let relaunched = try CoreEventProjectionStore(directory: projectionDirectory, hostID: host.id,
            resource: restored.resource, sessionID: try XCTUnwrap(restored.sessionID))
        XCTAssertEqual(relaunched.cursor, projection.cursor)
        XCTAssertEqual(relaunched.events, projection.events)
        _ = try await restored.request("events.ack", params: ["subscriptionId": .string(replayed.subscriptionId), "seq": .number(Double(replayed.nextCursor))])
        _ = try await restored.request("events.unsubscribe", params: ["subscriptionId": .string(replayed.subscriptionId)])
        XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 1)

        // A held real runtime turn accepts pause and settles through host events.
        phase = "held execution pause"
        _ = try await restored.request("input.claim", params: ["owner": .string(owner)])
        let held = try await restored.request("execution.execute", params: ["owner": .string(owner), "prompt": .string("HOLD_LINE_INTEGRATION")])
        _ = try await eventually("held execution running") {
            let state = try fixture.request(["op": .string("state")])
            return state["executions"].array?.contains(where: { $0["id"].string == held["executionId"].string && $0["state"].string == "running" }) == true ? state : nil
        }
        let pause = try await restored.request("control.request", params: ["owner": .string(owner), "action": .string("pause")])
        XCTAssertEqual(pause["state"].string, "accepted")
        _ = try await eventually("held execution stopped") {
            let state = try fixture.request(["op": .string("state")])
            return state["executions"].array?.contains(where: { $0["id"].string == held["executionId"].string && ["stopped", "finished"].contains($0["state"].string ?? "") }) == true ? state : nil
        }
        let paused = try await restored.request("events.list", params: ["after": .number(Double(projection.cursor)), "limit": .number(50)])
        XCTAssertTrue(paused["events"].array?.contains { $0["type"].string == "control.observed" && $0["data"]["id"].string == pause["controlId"].string } == true)

        // A pending approval travels through the same scoped question/answer path.
        phase = "pending approval and idempotent answer"
        let approval = try await restored.request("execution.execute", params: ["owner": .string(owner), "prompt": .string("APPROVAL_LINE_INTEGRATION")])
        let pending = try await eventually("pending approval question") {
            let current = try await restored.request("session.get")
            return current["questions"].array?.first
        }
        let answerID = CoreRelayClient.commandID()
        let answer: [String: CoreJSONValue] = ["owner": .string(owner), "questionId": .string(try XCTUnwrap(pending["id"].string)), "answer": .string("no")]
        let answered = try await restored.request("question.answer", params: answer, id: answerID)
        let repeatedAnswer = try await restored.request("question.answer", params: answer, id: answerID)
        XCTAssertEqual(answered, repeatedAnswer)
        _ = try await eventually("answered execution completion") {
            let state = try fixture.request(["op": .string("state")])
            return state["executions"].array?.contains(where: { $0["id"].string == approval["executionId"].string && $0["state"].string == "finished" }) == true ? state : nil
        }

        // The independently selected Core coordinator uses its own context/model.
        phase = "coordinator task"
        let taskClient = CoreRelayClient(transport: transport, hostID: host.id, grantID: coordinator.grantID, resource: coordinator.resource)
        clients[taskClient.resource] = taskClient
        let taskSnapshot = try await taskClient.request("session.get")
        XCTAssertEqual(taskSnapshot["session"]["model"].string, "coordinator-fixture")
        XCTAssertNotEqual(taskSnapshot["session"]["id"], snapshot["session"]["id"])
        _ = try await taskClient.request("input.claim", params: ["owner": .string("task-phone")])
        let taskID = CoreRelayClient.commandID()
        let taskInput: [String: CoreJSONValue] = ["owner": .string("task-phone"), "instruction": .string("Offline coordinator line task")]
        let taskReceipt = try await taskClient.request("task.submit", params: taskInput, id: taskID)
        let taskRepeat = try await taskClient.request("task.submit", params: taskInput, id: taskID)
        XCTAssertEqual(taskReceipt["taskId"], taskRepeat["taskId"])
        _ = try await eventually("coordinator task completion") {
            let state = try fixture.request(["op": .string("state")])
            return state["executions"].array?.contains(where: { $0["sessionId"].string == configuration["taskSessionId"].string && $0["state"].string == "finished" }) == true ? state : nil
        }
        let taskResult = try await taskClient.request("task.get", params: ["taskId": try XCTUnwrap(taskReceipt["taskId"].string).asCoreString])
        XCTAssertEqual(taskResult["state"].string, "finished")
        XCTAssertEqual(taskResult["verification"].string, "not-assessed")
        XCTAssertEqual(taskResult["execution"]["exitCode"].integer, 0)
        XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 4)

        phase = "operator stop and explicit read-only recovery"
        let quiesced = try fixture.request(["op": .string("operator-stop")])
        XCTAssertEqual(quiesced["quiesced"].bool, true)
        for operation in ["session.get", "host.metrics"] {
            do { _ = try await restored.request(operation); XCTFail("A stopped Core must not report readiness") }
            catch { XCTAssertEqual((error as? CoreApplicationError)?.code, "CORE_STOPPED") }
        }
        for value in clients.values { value.disconnected() }
        clients.removeAll(); transport.disconnect()
        XCTAssertEqual(try fixture.request(["op": .string("operator-start")])["ready"].bool, true)
        _ = try await transport.connect()
        let recovered = CoreRelayClient(transport: transport, hostID: host.id, grantID: client.grantID, resource: client.resource)
        clients[recovered.resource] = recovered
        _ = try await recovered.request("session.get")
        _ = try CoreHostMetrics(try await recovered.request("host.metrics"))
        XCTAssertEqual(try fixture.request(["op": .string("state")])["executionCount"].integer, 4,
            "Explicit Core restart and read-only reconnect never resume or create model work")

        phase = "revocation and reconnect denial"
        XCTAssertEqual(try fixture.request(["op": .string("revoke"), "grantId": grant["id"]])["revoked"].bool, true)
        do { _ = try await transport.inspect(client.grantID); XCTFail("Revoked access must be rejected") }
        catch { XCTAssertEqual((error as? RelayFailure)?.code, "GRANT_UNAVAILABLE") }
        transport.disconnect(); _ = try await transport.connect()
        do { _ = try await transport.inspect(client.grantID); XCTFail("Reconnecting cannot restore revoked access") }
        catch { XCTAssertEqual((error as? RelayFailure)?.code, "GRANT_UNAVAILABLE") }
        XCTAssertTrue(payloadErrors.isEmpty, "Valid actual host payloads must pass the native schema")
        XCTAssertEqual(try fixture.request(["op": .string("state")])["plaintextLeak"].bool, false)
        } catch {
            let code = (error as? CoreApplicationError)?.code ?? (error as? RelayFailure)?.code ?? String(reflecting: type(of: error))
            XCTFail("Native Core line failed during \(phase): \(code)")
            throw error
        }
    }

    @MainActor private func eventually<T>(_ context: String = "condition", _ check: () async throws -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if let result = try await check() { return result }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Native Core line timed out waiting for \(context)")
        throw CoreApplicationError("LINE_CHECK_TIMEOUT")
    }

    @MainActor func testNativeAgentsSharingAndNotificationPermissions() async throws {
        var phase = "fixture and pairing"
        do {
        let fixture = try LocalCoreLineFixture(); defer { fixture.shutdown() }
        let identity = try RelayIdentity.generate()
        let configuration = try fixture.request(["op": .string("start"), "advanced": .bool(true), "certificate": try RelayWire.object(identity.certificate)])
        let transport = try RelayTransport(identity: identity, loopbackEndpoint: XCTUnwrap(URL(string: try XCTUnwrap(configuration["endpoint"].string))))
        defer { transport.disconnect() }
        let host = try RelayCertificate.parse(configuration["host"]); try transport.trust(host)
        _ = try await transport.connect()
        let claim = try await transport.request("invite.claim", fields: ["code": configuration["direct"]["code"]])
        let decision = try await eventually {
            let value = try await transport.request("invite.status", fields: ["claimId": claim["claimId"]])
            return value["state"].string == "approved" ? value : nil
        }
        let grantID = try XCTUnwrap(decision["grant"]["id"].string)
        let client = CoreRelayClient(transport: transport, hostID: host.id, grantID: grantID,
            resource: try XCTUnwrap(decision["grant"]["spec"]["resource"].string))
        var clients = [client.resource: client], payloadErrors: [String] = []
        transport.onPayload = { from, grant, payload in
            for value in clients.values where value.grantID == grant {
                if let resource = payload["resource"].string, resource != value.resource { continue }
                do { try value.receive(from: from, grantID: grant, payload: payload) }
                catch { payloadErrors.append((error as? CoreApplicationError)?.code ?? "INVALID_PAYLOAD") }
            }
        }
        let snapshot = try await client.request("session.get")
        XCTAssertEqual(snapshot["capabilities"]["agentAccess"].bool, true)
        XCTAssertEqual(snapshot["capabilities"]["shareAccess"].bool, true)
        let registration = try await client.request("notifications.register", params: ["deviceToken": .string(String(repeating: "ab", count: 32)),
            "environment": .string("sandbox"), "enabled": .bool(true), "scope": .string("terminals")])
        XCTAssertEqual(registration["registered"].bool, true)
        XCTAssertEqual(registration["providerConfigured"].bool, false, "No real Apple credentials are used by this test")
        _ = try await client.request("notifications.update", params: ["enabled": .bool(false)])
        _ = try await client.request("notifications.revoke")
        let agentStatus = try await client.request("agents.status")
        XCTAssertEqual(agentStatus["scheduling"].bool, false)
        let providers = try await client.request("agents.providers")
        XCTAssertTrue(providers["providers"].array?.contains { $0["id"].string == "codex" } == true)
        let createID = CoreRelayClient.commandID()
        let definition: [String: CoreJSONValue] = ["name": .string("Native project helper"), "instructions": .string("Explain this approved project with evidence."),
            "provider": .string("codex"), "model": .string("fixture-model")]
        let created = try await client.request("agents.create", params: definition, id: createID)
        let repeated = try await client.request("agents.create", params: definition, id: createID)
        XCTAssertEqual(created["agent"]["id"], repeated["agent"]["id"])
        let agentID = try XCTUnwrap(created["agent"]["id"].string)
        let selected = try await client.request("agents.open", params: ["agentId": .string(agentID)])
        XCTAssertEqual(selected["kind"].string, "agent")
        let resource = try XCTUnwrap(selected["resource"].string)
        let agent = CoreRelayClient(transport: transport, hostID: host.id, grantID: grantID, resource: resource, expectedShareKind: .agent)
        clients[resource] = agent
        _ = try await agent.request("session.get")
        let listed = try await client.request("agents.list")
        XCTAssertEqual(listed["agents"].array?.first?["existingResource"].string, resource)
        _ = try await agent.request("input.claim", params: ["owner": .string("native-agent")])
        let run = try await agent.request("execution.execute", params: ["owner": .string("native-agent"), "prompt": .string("Explain the project.")])
        _ = try await eventually {
            let state = try fixture.request(["op": .string("state")])
            return state["executions"].array?.contains { $0["id"].string == run["executionId"].string && $0["state"].string == "finished" } == true ? state : nil
        }
        let hasReply = try await hasFormattedReply(agent)
        XCTAssertTrue(hasReply)
        let shareID = CoreRelayClient.commandID(), share = try await client.request("share.create", id: shareID)
        XCTAssertTrue(share["code"].string?.hasPrefix("BZZY-TERMINAL-") == true)
        let shareAgain = try await client.request("share.create", id: shareID)
        XCTAssertEqual(shareAgain["code"], share["code"])
        let offerID = try XCTUnwrap(share["shareId"].string)
        let shareState = try await client.request("share.status", params: ["shareId": .string(offerID)])
        XCTAssertEqual(shareState["state"].string, "open")
        _ = try await client.request("share.revoke", params: ["shareId": .string(offerID)])
        phase = "Agent source share.create"
        let source = try await agent.request("share.create")
        XCTAssertEqual(source["kind"].string, "AGENT")
        let importParams: [String: CoreJSONValue] = ["code": source["code"], "expectedSenderFingerprint": .string(host.id),
            "provider": .string("codex"), "model": .string("fixture-model"), "effort": .string("default"), "name": .string("Imported native helper")]
        let importRequest = CoreRelayClient.commandID()
        phase = "Agent import acceptance"
        let importing = try await client.request("agents.import", params: importParams, id: importRequest)
        let sameImport = try await client.request("agents.import", params: importParams, id: importRequest)
        XCTAssertEqual(importing["importId"], sameImport["importId"])
        let importID = try XCTUnwrap(importing["importId"].string), sourceID = try XCTUnwrap(source["shareId"].string)
        phase = "Agent recipient fingerprint"
        let waiting = try await eventually("Agent recipient fingerprint") {
            let status = try await client.request("agents.import.status", params: ["importId": .string(importID)])
            return status["recipientFingerprint"].string != nil ? status : nil
        }
        phase = "Agent source approval claim"
        let sourcePending = try await eventually("Agent source approval claim") {
            let status = try await agent.request("share.status", params: ["shareId": .string(sourceID)])
            return status["pending"].array?.isEmpty == false ? status : nil
        }
        let recipientClaim = try XCTUnwrap(sourcePending["pending"].array?.first)
        XCTAssertEqual(recipientClaim["fingerprint"], waiting["recipientFingerprint"])
        phase = "Agent source approval"
        _ = try await agent.request("share.approve", params: ["shareId": .string(sourceID), "claimId": recipientClaim["claimId"], "confirmedFingerprint": waiting["recipientFingerprint"]])
        phase = "Agent full-context transfer"
        let imported = try await eventually("full Agent context import") {
            let status = try await client.request("agents.import.status", params: ["importId": .string(importID)])
            if status["state"].string == "failed" { throw CoreApplicationError(status["errorCode"].string ?? "IMPORT_INVALID") }
            return status["state"].string == "complete" ? status : nil
        }
        XCTAssertNotEqual(imported["agent"]["id"].string, agentID)
        XCTAssertNotEqual(imported["agent"]["sessionId"].string, selected["sessionId"].string)
        XCTAssertEqual(imported["agent"]["state"].string, "idle")
        XCTAssertEqual(imported["agent"]["importId"].string, importID)
        let importedID = try XCTUnwrap(imported["agent"]["id"].string)
        phase = "Imported Agent observation"
        let importedContext = try await client.request("agents.open", params: ["agentId": .string(importedID)])
        let importedClient = CoreRelayClient(transport: transport, hostID: host.id, grantID: grantID,
            resource: try XCTUnwrap(importedContext["resource"].string), expectedShareKind: .agent)
        clients[importedClient.resource] = importedClient
        _ = try await importedClient.request("session.get")
        let hasImportedReply = try await hasFormattedReply(importedClient)
        XCTAssertTrue(hasImportedReply)
        let afterImport = try fixture.request(["op": .string("state")])
        XCTAssertEqual(afterImport["nativeExecutionCount"].integer, 1, "Import/open never starts inference")
        XCTAssertEqual(afterImport["importedExecutionCount"].integer, 1, "The source execution is preserved as imported historical context")
        XCTAssertEqual(afterImport["executionCount"].integer, 2)
        phase = "Imported Agent cleanup"
        _ = try await client.request("agents.archive", params: ["agentId": .string(importedID), "expectedRevision": imported["agent"]["revision"]])
        let changed = try await client.request("agents.update", params: ["agentId": .string(agentID), "expectedRevision": .number(1), "name": .string("Reviewed helper")])
        XCTAssertEqual(changed["agent"]["revision"].integer, 2)
        _ = try await client.request("agents.archive", params: ["agentId": .string(agentID), "expectedRevision": .number(2)])
        let remaining = try await client.request("agents.list")
        XCTAssertTrue(remaining["agents"].array?.isEmpty == true)
        XCTAssertTrue(payloadErrors.isEmpty)
        XCTAssertEqual(try fixture.request(["op": .string("state")])["nativeExecutionCount"].integer, 1)
        } catch {
            XCTFail("Native Agent transfer failed during \(phase): \((error as? CoreApplicationError)?.code ?? String(describing: type(of: error)))")
            throw error
        }
    }
}

private extension String { var asCoreString: CoreJSONValue { .string(self) } }

@MainActor private func hasFormattedReply(_ client: CoreRelayClient) async throws -> Bool {
    var cursor: Int64 = 0
    for _ in 0..<20 {
        let page = try await client.request("events.list", params: ["after": .number(Double(cursor)), "limit": .number(50)])
        if page["events"].array?.contains(where: { $0["type"].string == "text" && $0["data"]["text"].string?.contains("<message version=\"1\">") == true }) == true { return true }
        guard page["hasMore"].bool == true, let next = page["nextCursor"].integer, next > cursor else { return false }
        cursor = next
    }
    return false
}

private final class LocalCoreLineFixture {
    private let process = Process(), input = Pipe(), output = Pipe(), errors = Pipe()
    private var buffer = Data(), stopped = false
    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: root.deletingLastPathComponent().appendingPathComponent("BZZY-CORE/src/core.js").path) else {
            throw XCTSkip("Full workspace Core and Relay packages are required")
        }
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [ProcessInfo.processInfo.environment["BZZY_TEST_NODE"] ?? "node", root.appendingPathComponent("tools/core-line-fixture.mjs").path]
        let allowed = Set(["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SHELL", "USER", "LOGNAME"])
        process.environment = ProcessInfo.processInfo.environment.filter { allowed.contains($0.key) }
        let version = Process(), versionOutput = Pipe()
        version.executableURL = process.executableURL
        version.arguments = [process.arguments![0], "--version"]
        version.environment = process.environment
        version.standardOutput = versionOutput; version.standardError = FileHandle.nullDevice
        try version.run(); version.waitUntilExit()
        let versionText = String(decoding: versionOutput.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        guard version.terminationStatus == 0, let major = Int(versionText.dropFirst().split(separator: ".").first ?? ""), major >= 24 else {
            throw XCTSkip("The Core line check requires Node.js 24+. Put it on PATH or set BZZY_TEST_NODE; a skipped check does not establish install readiness.")
        }
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
    }
    func request(_ fields: [String: WireValue]) throws -> WireValue {
        try input.fileHandleForWriting.write(contentsOf: WireValue.object(fields).data() + Data([10]))
        while !buffer.contains(10) {
            let next = output.fileHandleForReading.availableData
            guard !next.isEmpty, buffer.count + next.count <= 65_536 else { throw CoreApplicationError("LINE_FIXTURE_PROCESS_FAILED") }
            buffer.append(next)
        }
        let newline = buffer.firstIndex(of: 10)!
        let data = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
        let frame = try WireValue.parse(Data(data))
        guard frame["ok"].bool == true else { throw CoreApplicationError("LINE_FIXTURE_" + (frame["error"].string ?? "FAILED")) }
        return frame["result"]
    }
    func shutdown() {
        guard !stopped else { return }; stopped = true
        if process.isRunning { _ = try? request(["op": .string("stop")]); try? input.fileHandleForWriting.close(); process.waitUntilExit() }
    }
    deinit { if process.isRunning { process.terminate() } }
}
