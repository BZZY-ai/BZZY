import XCTest

final class BZZYUITests: XCTestCase {
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
        app.launchArguments = ["--ui-testing", "--reset-ui-testing", "--relay-smoke-test", "--core-offline-testing"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Pair BZZY Core"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["tab-agents"].exists)
        XCTAssertFalse(app.buttons["tab-terminal"].exists)
        XCTAssertFalse(app.buttons["create-agent"].exists)
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
        XCTAssertTrue(app.staticTexts["Core offline"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Relay connected · Core connection required"].exists)
        XCTAssertTrue(app.staticTexts["Agents locked"].exists)
        XCTAssertTrue(app.staticTexts["Terminal locked"].exists)
        for identifier in ["tab-agents", "tab-terminal", "create-agent", "import-resource", "save-message"] {
            let action = app.buttons[identifier]
            if action.exists {
                XCTAssertFalse(action.isEnabled, "Cached navigation must be disabled while Core is offline")
                XCTAssertFalse(action.isHittable, "The offline shield must cover every workspace action")
            }
        }
        XCTAssertFalse(app.descendants(matching: .any)["host-metrics"].exists)
        XCTAssertFalse(app.buttons["save-message"].exists)
        app.buttons["Connection"].tap()
        XCTAssertTrue(app.staticTexts["Core offline"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.secureTextFields["pairing-code"].exists, "A saved approved pairing must not ask for another code")
        XCTAssertTrue(app.buttons["Forget host"].exists)
        app.buttons["Close"].tap()
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.staticTexts["Core offline"].waitForExistence(timeout: 5))
        if app.buttons["tab-agents"].exists { XCTAssertFalse(app.buttons["tab-agents"].isEnabled); XCTAssertFalse(app.buttons["tab-agents"].isHittable) }
        attach(app, name: "Paired Core offline locks workspaces")
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
        XCTAssertTrue(app.buttons["host-status"].exists)
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
        XCTAssertTrue(app.buttons["Workspace details"].waitForExistence(timeout: 5))
        app.buttons["Workspace details"].tap()
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
        app.buttons["tab-terminal"].tap()
        app.buttons["host-status"].tap()
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
        XCTAssertTrue(app.buttons["open-voice-chat"].waitForExistence(timeout: 10))
        app.buttons["open-voice-chat"].tap()
        let voice = app.descendants(matching: .any)["voice-only-chat"]
        XCTAssertTrue(voice.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["voice-chat-record"].exists, app.debugDescription)
        attach(app, name: "Voice-only minimal interface")
        XCTAssertEqual(voice.staticTexts.count, 0, "The voice screen must not display transcripts, labels or text status: \(voice.debugDescription)")
        app.buttons["Close voice chat"].tap()
        app.buttons["agent-COOL"].tap()
        let latest = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "We can keep it focused.")).firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 5)); XCTAssertTrue(latest.isHittable, "Opening an agent chat must land at the newest message")
        app.buttons["Back"].tap(); app.buttons["tab-terminal"].tap(); app.buttons["terminal-session-research"].tap()
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
        XCTAssertTrue(app.staticTexts["Demo"].waitForExistence(timeout: 3))
        let firstUser = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-user-")).firstMatch
        let firstAgent = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-assistant-")).firstMatch
        XCTAssertTrue(firstUser.exists && firstAgent.exists)
        XCTAssertGreaterThan(firstUser.frame.minX, firstAgent.frame.minX)
        XCTAssertTrue(app.descendants(matching: .any)["chat-rich-table"].exists, app.debugDescription)
        attach(app, name: "iOS COOL Chat")
        let draft = app.descendants(matching: .any).matching(identifier: "message-draft").firstMatch
        draft.tap(); draft.typeText("Let's start with chat")
        app.buttons["save-message"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "What would you like to work through first?")).firstMatch.waitForExistence(timeout: 3))
        app.buttons["Back"].tap()
        app.buttons["tab-terminal"].tap()
        app.buttons["terminal-session-design"].tap()
        XCTAssertTrue(app.staticTexts["Codex · Demo"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["chat-code-block"].exists)
        attach(app, name: "iOS Terminal Chat")
        app.buttons["Back"].tap()
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
        XCTAssertTrue(app.buttons["host-status"].exists)
    }

    func testShareAndImportAgentDemo() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["agent-COOL"].waitForExistence(timeout: 10))
        app.buttons["agent-COOL"].tap()
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
        app.buttons["Back"].tap()
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
        XCTAssertTrue(app.staticTexts["Draft · On demand"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["chat-rich-table"].exists)
        app.buttons["share-resource"].tap()
        XCTAssertTrue(app.staticTexts["share-host-required"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["share-try-demo"].exists)
        app.buttons["Close"].firstMatch.tap()
        app.buttons["Back"].tap()
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
        app.buttons["share-resource"].tap()
        app.buttons["share-try-demo"].tap()
        XCTAssertTrue(app.staticTexts["share-code"].waitForExistence(timeout: 3))
        let raw = app.staticTexts["share-code"].label
        XCTAssertTrue(raw.hasPrefix("BZZY-DEMO-TERMINAL-"))
        attach(app, name: "iOS Share Terminal QR")
        app.buttons["Close"].firstMatch.tap()
        app.buttons["Back"].tap()
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
        XCTAssertTrue(app.staticTexts["Draft · Inactive"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["chat-code-block"].exists)
        let composer = app.textFields["message-draft"]
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

    private func attach(_ app: XCUIApplication, name: String) {
        // Let native sheet/keyboard compositor transitions finish before capturing.
        Thread.sleep(forTimeInterval: 0.6)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
