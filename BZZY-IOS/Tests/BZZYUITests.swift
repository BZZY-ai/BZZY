import XCTest

final class BZZYUITests: XCTestCase {
    func testCompactFooterAndRecordedInvocationMessages() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--invocation-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["create-agent"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["open-voice-chat"].exists)
        XCTAssertFalse(app.staticTexts["Talk to BZZY"].exists)
        let status = app.staticTexts["connection-status-label"], refresh = app.buttons["refresh-connection"]
        let metrics = app.descendants(matching: .any)["host-metrics"]
        XCTAssertTrue(metrics.exists)
        XCTAssertGreaterThan(metrics.frame.midX, status.frame.maxX)
        XCTAssertLessThan(metrics.frame.midX, refresh.frame.minX)
        let agentRefresh = app.buttons["refresh-agents"]
        XCTAssertLessThanOrEqual(agentRefresh.frame.width, 48)
        XCTAssertEqual(agentRefresh.staticTexts.count, 0)
        attach(app, name: "Compact footer with centered host metrics and icon refresh")
        app.buttons["agent-COOL"].tap()
        XCTAssertTrue(app.staticTexts["chat-invocation-ui-skill-receipt"].waitForExistence(timeout: 5))
        let skill = app.staticTexts["chat-invocation-ui-skill-receipt"]
        XCTAssertTrue(skill.label.contains("header-checks")); XCTAssertTrue(skill.label.contains("Loaded"))
        let agent = app.staticTexts["chat-invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]
        XCTAssertTrue(agent.label.contains("http-reviewer")); XCTAssertTrue(agent.label.contains("Review accepted"))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "The actual HTTP response headers were preserved.")).firstMatch.exists)
        attach(app, name: "Terminal-style skill and agent steps retain actual returned text")
    }
    func testRepeatedChatBackAndSheetTransitionsKeepChromeAndUnsentDraftsInTheRightScreen() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["tab-terminal"].waitForExistence(timeout: 10))
        app.buttons["tab-terminal"].tap()
        for iteration in 0..<3 {
            app.buttons["terminal-session-design"].tap()
            assertCompactChatHeader(app)
            let draft = app.textViews["message-draft"]
            if iteration == 0 { draft.tap(); draft.typeText("Unsent transition draft") }
            XCTAssertEqual(draft.value as? String, "Unsent transition draft")
            app.buttons["chat-settings"].tap(); app.buttons["Details"].tap()
            XCTAssertTrue(app.buttons["Close"].firstMatch.waitForExistence(timeout: 3))
            app.buttons["Close"].firstMatch.tap()
            assertCompactChatHeader(app)
            XCTAssertEqual(draft.value as? String, "Unsent transition draft")
            draft.tap()
            if iteration == 1 {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.45))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.45)),
                           withVelocity: .slow, thenHoldForDuration: 0.3)
                assertCompactChatHeader(app)
                XCTAssertEqual(draft.value as? String, "Unsent transition draft")
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.45))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.45)))
            } else { app.buttons["chat-back"].tap() }
            XCTAssertTrue(app.buttons["terminal-session-design"].waitForExistence(timeout: 3))
            XCTAssertTrue(app.staticTexts["BZZY"].exists)
            XCTAssertTrue(app.buttons["tab-terminal"].isHittable)
            XCTAssertFalse(app.buttons["chat-settings"].exists)
            XCTAssertFalse(app.keyboards.firstMatch.exists)
        }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.45))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.45)))
        XCTAssertTrue(app.buttons["terminal-session-design"].isHittable)
        XCTAssertTrue(app.buttons["tab-terminal"].isHittable)
        app.buttons["terminal-session-research"].tap()
        XCTAssertNotEqual(app.textViews["message-draft"].value as? String, "Unsent transition draft")
        app.buttons["chat-back"].tap()
        app.buttons["tab-agents"].tap(); app.buttons["agent-COOL"].tap()
        assertCompactChatHeader(app)
        app.buttons["chat-back"].tap()
        XCTAssertTrue(app.buttons["create-agent"].waitForExistence(timeout: 3))
        attach(app, name: "Repeated Back and sheets restore home controls without leaking chat drafts")
    }

    func testComputerSelectionSurvivesForegroundAndColdLaunchUsesDefaultWithoutLeakingSessions() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--multi-host-testing"]
        app.launch()
        let selector = app.buttons["host-selector"]
        XCTAssertTrue(selector.waitForExistence(timeout: 10))
        XCTAssertEqual(selector.value as? String, "Real server")
        XCTAssertEqual(app.staticTexts["connection-status-label"].label, "Offline")
        selector.tap()
        XCTAssertTrue(app.buttons["Select Test Mac"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Not selected · Status unknown"].exists)
        app.buttons["Select Test Mac"].tap()
        XCTAssertEqual(selector.value as? String, "Test Mac")
        XCTAssertTrue(app.buttons["terminal-live"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Test only dummy chat"].exists)
        XCTAssertFalse(app.buttons["terminal-live"].isEnabled)
        XCTAssertTrue(selector.isEnabled)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertEqual(selector.value as? String, "Test Mac")
        let foregroundSelector = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in selector.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [foregroundSelector], timeout: 5), .completed)
        selector.tap(); app.buttons["Select Real server"].tap()
        XCTAssertEqual(selector.value as? String, "Real server")
        XCTAssertFalse(app.buttons["terminal-live"].exists)
        XCTAssertFalse(app.staticTexts["Test only dummy chat"].exists)
        selector.tap(); app.buttons["Select Test Mac"].tap()
        app.terminate()
        app.launchArguments = ["--ui-testing", "--multi-host-testing"]
        app.launch()
        XCTAssertTrue(selector.waitForExistence(timeout: 10))
        XCTAssertEqual(selector.value as? String, "Real server")
        XCTAssertFalse(app.staticTexts["Test only dummy chat"].exists)
        attach(app, name: "Computer selector remains available offline and cold launch chooses Real server")
    }

    func testComputerFriendlyNameAndDefaultPersistAndAddingKeepsBothProfiles() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--multi-host-testing"]
        app.launch()
        let selector = app.buttons["host-selector"]
        XCTAssertTrue(selector.waitForExistence(timeout: 10))
        selector.tap()
        app.buttons["Options for Test Mac"].tap()
        app.buttons["Rename"].tap()
        let name = app.alerts.textFields.firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        name.tap(); name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Test Mac".count) + "Lab Mac")
        app.alerts.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Select Lab Mac"].exists)
        app.buttons["Options for Lab Mac"].tap(); app.buttons["Set as default"].tap()
        app.buttons["add-computer"].tap()
        XCTAssertTrue(app.staticTexts["Add computer"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.secureTextFields["pairing-code"].exists)
        app.buttons["close-connection"].tap()
        XCTAssertTrue(app.buttons["Select Lab Mac"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Select Real server"].exists)
        app.buttons["close-host-picker"].tap()
        app.terminate()
        app.launchArguments = ["--ui-testing", "--multi-host-testing"]
        app.launch()
        XCTAssertTrue(selector.waitForExistence(timeout: 10))
        XCTAssertEqual(selector.value as? String, "Lab Mac")
        selector.tap()
        XCTAssertTrue((app.buttons["Select Lab Mac"].value as? String)?.contains("Default on launch") == true)
        XCTAssertTrue(app.buttons["Select Real server"].exists)
        let readySheet = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.buttons["add-computer"].isHittable && app.buttons["close-host-picker"].isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [readySheet], timeout: 5), .completed)
        attach(app, name: "Friendly name and launch default survive relaunch")
    }

    func testHistoryOpensAtLatestAndLoadsEarlierWithoutJumpingBackToBottom() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--history-paging-testing"]
        app.launch()
        app.buttons["agent-COOL"].tap()
        XCTAssertTrue(app.staticTexts["History entry 225"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["History entry 225"].isHittable)
        XCTAssertEqual(app.scrollViews["conversation-history"].value as? String, "50 messages")
        let scroll = app.scrollViews.firstMatch
        let earlier = app.buttons["load-earlier-messages"]
        let first = app.staticTexts["History entry 001"]
        for _ in 0..<80 {
            if first.exists && first.isHittable { break }
            if earlier.exists && earlier.isHittable && earlier.isEnabled { earlier.tap() }
            scroll.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(first.isHittable)
        XCTAssertFalse(app.staticTexts["History entry 225"].isHittable)
        attach(app, name: "Earlier history remains in place")
        app.buttons["chat-jump-to-latest"].tap()
        XCTAssertTrue(app.staticTexts["History entry 225"].isHittable)
    }
    func testGoalShortcutsPrepareTheEditorAndLeaveResumeDisabledWithoutAStalledGoal() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        app.buttons["agent-COOL"].tap()
        app.buttons["chat-settings"].tap()
        let set = app.buttons["set-goal"], draft = app.textViews["message-draft"]
        XCTAssertTrue(set.waitForExistence(timeout: 5)); XCTAssertTrue(set.isEnabled)
        XCTAssertFalse(app.buttons["resume-goal"].exists)
        XCTAssertFalse(app.staticTexts["BZZY"].exists, "The global header is hidden inside chat")
        set.tap()
        XCTAssertEqual(draft.value as? String, "/goal ")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        draft.typeText("Review this project")
        XCTAssertEqual(draft.value as? String, "/goal Review this project")
        app.buttons["chat-settings"].tap(); set.tap(); draft.typeText(" safely")
        XCTAssertEqual(draft.value as? String, "/goal Review this project safely")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        attach(app, name: "Compact goal shortcuts and focused green command")
    }
    func testGoalComposerKeepsKeyboardAndSelectionWhileStylingCommand() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.staticTexts["BZZY"].waitForExistence(timeout: 10))
        app.buttons["agent-COOL"].tap()
        let draft = app.textViews["message-draft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 3))
        draft.tap(); draft.typeText("/goal")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        draft.typeText(" tell me Messi age")
        XCTAssertEqual(draft.value as? String, "/goal tell me Messi age")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        attach(app, name: "Stable native goal editor")
        draft.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "/goal tell me Messi age".count))
        draft.typeText("A normal message")
        XCTAssertEqual(draft.value as? String, "A normal message")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
    }
    #if !DEBUG
    func testReleaseIgnoresPreviewArgumentsAndRequiresApprovedCorePair() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--relay-smoke-test", "--core-offline-testing", "--multi-host-testing"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Pair BZZY Core"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["tab-agents"].exists)
        XCTAssertFalse(app.buttons["tab-terminal"].exists)
        XCTAssertFalse(app.buttons["create-agent"].exists)
        XCTAssertFalse(app.buttons["host-selector"].exists)
        XCTAssertFalse(app.staticTexts["relay-smoke-result"].exists)
        XCTAssertFalse(app.buttons["Close"].exists)
        attach(app, name: "Release requires approved Core pairing")
    }
    #endif

    func testPairedButOfflineCoreLocksWorkspacesDespiteRelayConnection() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--core-offline-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.staticTexts["BZZY"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["connection-status-label"].label, "Offline")
        XCTAssertFalse(app.descendants(matching: .any)["core-offline-lock"].exists)
        XCTAssertFalse(app.staticTexts["Connecting to Core"].exists)
        XCTAssertTrue(app.buttons["tab-agents"].exists)
        XCTAssertTrue(app.buttons["tab-terminal"].exists)
        for identifier in ["tab-agents", "tab-terminal", "create-agent", "import-resource", "open-voice-chat"] {
            let action = app.buttons[identifier]
            if action.exists { XCTAssertFalse(action.isEnabled, "Core-dependent actions remain disabled while offline") }
        }
        XCTAssertTrue(app.buttons["refresh-connection"].isEnabled)
        XCTAssertLessThanOrEqual(app.buttons["tab-agents"].frame.maxY, app.buttons["refresh-connection"].frame.minY)
        app.buttons["refresh-connection"].tap()
        XCTAssertTrue(app.staticTexts["BZZY"].exists)
        XCTAssertEqual(app.staticTexts["connection-status-label"].label, "Offline")
        let unavailableMetrics = app.descendants(matching: .any)["host-metrics"]
        XCTAssertTrue(unavailableMetrics.exists)
        XCTAssertEqual(unavailableMetrics.value as? String, "Waiting for Core", "Offline metrics remain placeholders rather than stale host readings")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.staticTexts["BZZY"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["connection-status-label"].label, "Offline")
        attach(app, name: "Offline main view with truthful connection footer")
    }

    func testFreshInstallRequiresApprovedCorePairBeforeNavigation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--pairing-gate-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Pair BZZY Core"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["tab-agents"].exists)
        XCTAssertFalse(app.buttons["tab-terminal"].exists)
        XCTAssertFalse(app.buttons["create-agent"].exists)
        XCTAssertFalse(app.buttons["Close"].exists)
        let code = app.secureTextFields["pairing-code"]
        XCTAssertTrue(code.exists)
        code.tap(); code.typeText("BZZY-PAIR-invalid")
        app.buttons["review-host"].tap()
        XCTAssertTrue(app.staticTexts["Pair BZZY Core"].exists)
        XCTAssertFalse(app.buttons["tab-terminal"].exists)
        XCTAssertFalse(app.buttons["Confirm host"].exists)
        attach(app, name: "Required Core pairing")
    }

    func testNavigationDraftsAndRelaunch() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["tab-agents"].waitForExistence(timeout: 10))
        attach(app, name: "iOS Agents")
        app.buttons["tab-terminal"].tap()
        XCTAssertFalse(app.buttons["host-status"].exists)
        XCTAssertTrue(app.staticTexts["connection-status-label"].exists)
        attach(app, name: "iOS Terminal")
        app.buttons["tab-agents"].tap()
        app.buttons["create-agent"].tap()
        XCTAssertFalse(app.textFields["agent-name"].exists)
        attach(app, name: "iOS Agent Types")
        app.buttons["agent-type-on-demand"].tap()
        let name = app.textFields["agent-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 3))
        name.tap()
        name.typeText("Orbit")
        let purpose = app.textFields["agent-purpose"]
        purpose.tap()
        purpose.typeText("Help me understand my authorized project")
        app.swipeUp()
        app.buttons["save-agent"].tap()
        attach(app, name: "iOS Open Workspace")
        let draft = app.descendants(matching: .any).matching(identifier: "message-draft").firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 5), app.debugDescription)
        draft.tap()
        draft.typeText("What changed in my project?")
        app.buttons["save-message"].tap()
        XCTAssertTrue(app.staticTexts["saved-draft"].waitForExistence(timeout: 3))
        attach(app, name: "iOS Conversation")
        app.terminate()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["tab-agents"].waitForExistence(timeout: 10))
        let orbit = app.buttons["agent-Orbit"]
        let scroll = app.scrollViews.firstMatch
        for _ in 0..<5 {
            if orbit.exists && orbit.frame.minY >= scroll.frame.minY && orbit.frame.maxY < app.buttons["tab-agents"].frame.minY - 10 { break }
            scroll.swipeUp()
        }
        XCTAssertTrue(orbit.exists)
        orbit.tap()
        XCTAssertTrue(app.staticTexts["What changed in my project?"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["voice-record"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["voice-record"].label, "Hold to talk")
        XCTAssertTrue(app.textFields["message-draft"].exists || app.textViews["message-draft"].exists)
        attach(app, name: "iOS Voice Composer")
        // Do not grant microphone access or capture the user's audio during a UI check.
    }

    func testScheduledAgentStartsWithTypeAndKeepsItsInterval() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["create-agent"].waitForExistence(timeout: 10))
        app.buttons["create-agent"].tap()
        app.buttons["agent-type-scheduled"].tap()
        app.textFields["agent-name"].tap()
        app.textFields["agent-name"].typeText("Pulse")
        app.textFields["agent-purpose"].tap()
        app.textFields["agent-purpose"].typeText("Review authorized project updates")
        app.swipeUp()
        app.buttons["Days"].tap()
        attach(app, name: "iOS Scheduled Agent")
        app.buttons["save-agent"].tap()
        XCTAssertTrue(app.buttons["chat-settings"].waitForExistence(timeout: 5))
        app.buttons["chat-settings"].tap()
        app.buttons["Details"].tap()
        XCTAssertTrue(app.staticTexts["Scheduled"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Every 1 day"].exists)
        XCTAssertTrue(app.staticTexts["Inactive"].exists)
    }

    func testConnectionAndNotificationSettings() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10))
        app.buttons["Settings"].tap()
        app.buttons["notification-settings"].tap()
        XCTAssertTrue(app.buttons["enable-notifications"].waitForExistence(timeout: 3))
        attach(app, name: "iOS Notifications")
        // Permissions and networking are disabled in ordinary UI tests.
        XCTAssertFalse(app.buttons["enable-notifications"].isEnabled)
        app.buttons["Close"].firstMatch.tap()
        app.buttons["Close"].firstMatch.tap()
        app.buttons["Settings"].tap()
        app.buttons["connection-settings"].tap()
        let code = app.secureTextFields["pairing-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 3))
        code.tap(); code.typeText("BZZY-AGENT-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        app.buttons["review-host"].tap()
        XCTAssertTrue(app.staticTexts["connection-error"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Use a PAIR invitation to connect a host."].exists)
        attach(app, name: "iOS Connect")
    }

    func testNativeNotificationPermissionAndDelivery() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--ui-notification-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 10))
        app.buttons["Settings"].tap()
        app.buttons["notification-settings"].tap()
        let enable = app.buttons["enable-notifications"]
        if enable.waitForExistence(timeout: 2) {
            enable.tap()
            let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
            if alert.waitForExistence(timeout: 3) {
                alert.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Allow", "Permitir")).firstMatch.tap()
            }
        }
        XCTAssertTrue(app.buttons["test-notification"].waitForExistence(timeout: 5))
        app.buttons["test-notification"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(springboard.staticTexts["Notifications are working."].waitForExistence(timeout: 8))
        attach(app, name: "iOS Notification Delivered")
        springboard.staticTexts["Notifications are working."].tap()
        XCTAssertTrue(app.staticTexts["Connect"].waitForExistence(timeout: 5))
    }

    func testNativeRelayTLSAuthenticationAndIsolatedKeychain() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--relay-smoke-test"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Relay and Keychain verified"].waitForExistence(timeout: 20), app.staticTexts["relay-smoke-result"].label)
        // Diagnostic identity is disposable and removed. No host invitations or commands are sent.
    }

    func testSpeechLanguagesPersistIndependentlyAndTerminalRowsShowOnlyAliases() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        app.buttons["Settings"].tap()
        let listening = app.segmentedControls["speech-recognition-language"]
        for _ in 0..<3 { if listening.exists && listening.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(listening.waitForExistence(timeout: 5))
        listening.buttons["Español"].tap()
        let speaking = app.segmentedControls["speech-synthesis-language"]
        speaking.buttons["English"].tap()
        XCTAssertTrue(listening.buttons["Español"].isSelected)
        XCTAssertTrue(speaking.buttons["English"].isSelected)
        attach(app, name: "Independent speech languages")
        app.terminate(); app.launchArguments = ["--ui-testing"]; app.launch()
        app.buttons["Settings"].tap()
        for _ in 0..<3 { if listening.exists && listening.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(listening.buttons["Español"].isSelected)
        XCTAssertTrue(speaking.buttons["English"].isSelected)
        app.buttons["Close"].tap(); app.buttons["tab-terminal"].tap()
        let row = app.buttons["terminal-session-design"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.staticTexts["Design review"].exists)
        XCTAssertEqual(row.staticTexts.count, 1, "A terminal row displays only its alias beside the icon")
        attach(app, name: "Alias-only terminal picker")
    }

    func testVoiceScreenHasOnlyControlsAndChatsOpenAtLatest() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertFalse(app.buttons["open-voice-chat"].exists)
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.buttons["open-voice-chat"].waitForExistence(timeout: 10))
        app.buttons["open-voice-chat"].tap()
        let voice = app.descendants(matching: .any)["voice-only-chat"]
        XCTAssertTrue(voice.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["voice-chat-record"].exists, app.debugDescription)
        attach(app, name: "Voice-only minimal interface")
        XCTAssertEqual(voice.staticTexts.count, 0, "The voice screen must not display transcripts, labels or text status: \(voice.debugDescription)")
        app.buttons["Close voice chat"].tap()
        app.buttons["Close"].firstMatch.tap()
        app.buttons["agent-COOL"].tap()
        let latest = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "We can keep it focused.")).firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 5)); XCTAssertTrue(latest.isHittable, "Opening an agent chat must land at the newest message")
        app.buttons["chat-back"].tap(); app.buttons["tab-terminal"].tap(); app.buttons["terminal-session-research"].tap()
        let terminalLatest = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Then refine the details.")).firstMatch
        XCTAssertTrue(terminalLatest.waitForExistence(timeout: 5)); XCTAssertTrue(terminalLatest.isHittable, "Opening a terminal chat must land at the newest message")
        attach(app, name: "Latest terminal message on entry")
    }

    func testAgentAndTerminalDemoChats() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["agent-COOL"].waitForExistence(timeout: 10))
        app.buttons["agent-COOL"].tap()
        assertCompactChatHeader(app)
        let firstUser = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-user-")).firstMatch
        let firstAgent = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-assistant-")).firstMatch
        XCTAssertTrue(firstUser.exists && firstAgent.exists)
        XCTAssertEqual(firstUser.frame.minX, firstAgent.frame.minX, accuracy: 1)
        XCTAssertGreaterThanOrEqual(firstUser.frame.minX, 16)
        XCTAssertTrue(app.descendants(matching: .any)["chat-rich-table"].exists, app.debugDescription)
        attach(app, name: "iOS COOL Chat")
        let draft = app.descendants(matching: .any).matching(identifier: "message-draft").firstMatch
        draft.tap(); draft.typeText("Let's start with chat")
        app.buttons["save-message"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "What would you like to work through first?")).firstMatch.waitForExistence(timeout: 3))
        app.buttons["chat-back"].tap()
        app.buttons["tab-terminal"].tap()
        app.buttons["terminal-session-design"].tap()
        assertCompactChatHeader(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat-code-block"].exists)
        attach(app, name: "iOS Terminal Chat")
        app.buttons["chat-back"].tap()
        app.buttons["terminal-session-research"].tap()
        attach(app, name: "iOS Research Chat")
    }

    func testSubscriptionDemoTableAndAccessibleChat() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["agent-Subscriptions"].waitForExistence(timeout: 10))
        app.buttons["agent-Subscriptions"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-rich-table"].waitForExistence(timeout: 3), app.debugDescription)
        attach(app, name: "iOS Subscriptions Chat")
        app.terminate()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
        app.launch()
        XCTAssertTrue(app.buttons["agent-COOL"].waitForExistence(timeout: 10))
        app.buttons["agent-COOL"].tap()
        XCTAssertTrue(app.buttons["save-message"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["save-message"].exists)
        attach(app, name: "iOS Accessible Chat")
    }

    func testNavigationAtAccessibilityTextSize() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
        app.launch()
        XCTAssertTrue(app.buttons["tab-agents"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["tab-agents"].isHittable)
        XCTAssertTrue(app.buttons["tab-terminal"].isHittable)
        attach(app, name: "iOS Accessibility Text")
        app.buttons["tab-terminal"].tap()
        XCTAssertFalse(app.buttons["host-status"].exists)
        XCTAssertTrue(app.staticTexts["connection-status-label"].exists)
        app.buttons["terminal-session-design"].tap()
        assertCompactChatHeader(app)
    }

    func testShareAndImportAgentDemo() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["agent-COOL"].waitForExistence(timeout: 10))
        app.buttons["agent-COOL"].tap()
        app.buttons["chat-settings"].tap()
        app.buttons["share-resource"].tap()
        XCTAssertTrue(app.staticTexts["share-host-required"].waitForExistence(timeout: 3))
        attach(app, name: "iOS Share Agent")
        app.buttons["Live access"].tap()
        XCTAssertTrue(app.staticTexts["View only"].exists)
        XCTAssertFalse(app.buttons["share-try-demo"].exists)
        app.buttons["Copy"].tap()
        app.buttons["share-try-demo"].tap()
        let code = app.staticTexts["share-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 3))
        let raw = code.label
        XCTAssertTrue(raw.hasPrefix("BZZY-DEMO-AGENT-"))
        XCTAssertTrue(app.descendants(matching: .any)["share-qr"].exists)
        app.buttons["share-copy-code"].tap()
        XCTAssertTrue(app.buttons["share-copy-code"].label.contains("Copied"))
        attach(app, name: "iOS Share Demo QR")
        app.buttons["Close"].firstMatch.tap()
        app.buttons["chat-back"].tap()
        app.buttons["import-resource"].tap()
        XCTAssertTrue(app.secureTextFields["import-code"].waitForExistence(timeout: 3))
        attach(app, name: "iOS Import Agent")
        app.secureTextFields["import-code"].tap()
        app.secureTextFields["import-code"].typeText(raw)
        app.buttons["import-review"].tap()
        XCTAssertTrue(app.staticTexts["No permissions granted"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Read project"].exists)
        attach(app, name: "iOS Import Review")
        app.buttons["import-confirm"].tap()
        XCTAssertTrue(app.staticTexts["import-complete"].waitForExistence(timeout: 3))
        app.buttons["import-done"].tap()
        let imported = app.buttons["agent-COOL 2"]
        for _ in 0..<4 {
            if imported.exists && imported.frame.maxY < app.buttons["tab-agents"].frame.minY - 10 { break }
            app.scrollViews.firstMatch.swipeUp()
        }
        imported.tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation-mode"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["chat-rich-table"].exists)
        app.buttons["chat-settings"].tap()
        app.buttons["share-resource"].tap()
        XCTAssertTrue(app.staticTexts["share-host-required"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["share-try-demo"].exists)
        app.buttons["Close"].firstMatch.tap()
        app.buttons["chat-back"].tap()
        app.buttons["import-resource"].tap()
        app.secureTextFields["import-code"].tap()
        app.secureTextFields["import-code"].typeText(raw)
        app.buttons["import-review"].tap()
        XCTAssertTrue(app.staticTexts["import-error"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["import-confirm"].exists)
    }

    func testShareAndImportTerminalDemoAndPurposeChecks() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["tab-terminal"].waitForExistence(timeout: 10))
        app.buttons["tab-terminal"].tap()
        app.buttons["terminal-session-design"].tap()
        app.buttons["chat-settings"].tap()
        app.buttons["share-resource"].tap()
        app.buttons["share-try-demo"].tap()
        XCTAssertTrue(app.staticTexts["share-code"].waitForExistence(timeout: 3))
        let raw = app.staticTexts["share-code"].label
        XCTAssertTrue(raw.hasPrefix("BZZY-DEMO-TERMINAL-"))
        attach(app, name: "iOS Share Terminal QR")
        app.buttons["Close"].firstMatch.tap()
        app.buttons["chat-back"].tap()
        app.buttons["import-resource"].tap()
        let input = app.secureTextFields["import-code"]
        XCTAssertTrue(input.waitForExistence(timeout: 3))
        input.tap(); input.typeText("BZZY-PAIR-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        app.buttons["import-review"].tap()
        XCTAssertTrue(app.staticTexts["Use a TERMINAL invitation in this tab."].waitForExistence(timeout: 3))
        input.tap(); input.typeText("BZZY-TERMINAL-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        app.buttons["import-review"].tap()
        XCTAssertTrue(app.staticTexts["import-host-required"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["import-confirm"].exists)
        attach(app, name: "iOS Relay Import Pending")
        app.buttons["Use another code"].tap()
        input.tap(); input.typeText(raw)
        app.buttons["import-review"].tap()
        XCTAssertTrue(app.staticTexts["Choose workspace"].waitForExistence(timeout: 3))
        app.buttons["import-confirm"].tap()
        app.buttons["import-done"].tap()
        let draft = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "terminal-draft-")).firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 3))
        draft.tap()
        XCTAssertTrue(app.descendants(matching: .any)["conversation-mode"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["chat-code-block"].exists)
        let composer = app.textViews["message-draft"]
        composer.tap(); composer.typeText("Keep this local")
        app.buttons["save-message"].tap()
        app.terminate()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        app.buttons["tab-terminal"].tap()
        let restored = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "terminal-draft-")).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 3))
        restored.tap()
        XCTAssertTrue(app.staticTexts["Keep this local"].waitForExistence(timeout: 3))
        attach(app, name: "iOS Imported Terminal Draft")
    }

    func testSharingAtAccessibilityTextSize() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
        app.launch()
        XCTAssertTrue(app.buttons["import-resource"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["import-resource"].isHittable)
        app.buttons["import-resource"].tap()
        XCTAssertTrue(app.buttons["import-scan"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["import-scan"].isHittable)
        attach(app, name: "iOS Accessible Import")
        app.buttons["Close"].firstMatch.tap()
        app.buttons["agent-COOL"].tap()
        app.buttons["chat-settings"].tap()
        app.buttons["share-resource"].tap()
        XCTAssertTrue(app.buttons["Live access"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Live access"].isHittable)
        let demoButton = app.buttons["share-try-demo"]
        for _ in 0..<3 { if demoButton.isHittable { break }; app.scrollViews.firstMatch.swipeUp() }
        demoButton.tap()
        let copyButton = app.buttons["share-copy-code"]
        for _ in 0..<3 { if copyButton.isHittable { break }; app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(copyButton.isHittable)
        copyButton.tap()
        attach(app, name: "iOS Accessible Share")
    }

    private func assertCompactChatHeader(_ app: XCUIApplication) {
        let title = app.staticTexts["conversation-title"], mode = app.descendants(matching: .any)["conversation-mode"]
        let back = app.buttons["chat-back"], settings = app.buttons["chat-settings"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(back.isHittable && settings.isHittable)
        XCTAssertEqual(mode.value as? String, "Solo")
        XCTAssertLessThanOrEqual(back.frame.maxX, title.frame.minX)
        XCTAssertLessThanOrEqual(title.frame.maxX, mode.frame.minX)
        XCTAssertLessThanOrEqual(mode.frame.maxX, settings.frame.minX)
        XCTAssertEqual(mode.frame.midY, settings.frame.midY, accuracy: 2)
        XCTAssertFalse(app.buttons["tab-terminal"].exists)
        XCTAssertFalse(app.staticTexts["BZZY"].exists)
    }

    private func attach(_ app: XCUIApplication, name: String) {
        // Let native sheet/keyboard compositor transitions finish before capturing.
        Thread.sleep(forTimeInterval: 0.6)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
