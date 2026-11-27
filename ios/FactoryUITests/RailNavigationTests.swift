import XCTest

final class RailNavigationTests: XCTestCase {
    @MainActor
    func testSystemSignInThenBackRetracesRelatedTicketToQueue() {
        continueAfterFailure = false
        let timeout: TimeInterval = 30
        let app = XCUIApplication()
        app.launch()
        let queue = app.buttons["Queue"]
        func tap(_ element: XCUIElement) {
            XCTAssertTrue(element.waitForExistence(timeout: timeout), "Missing \(element)")
            element.tap()
        }
        XCTAssertTrue(app.staticTexts["Factory is unreachable"].waitForExistence(timeout: timeout))
        tap(app.buttons["Retry connection"].firstMatch)
        tap(app.buttons["Sign in with SSO"])
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let consent = system.alerts.buttons["Continue"]
        let appConsent = app.alerts.buttons["Continue"]
        let ready = NSPredicate { _, _ in queue.exists || consent.exists || appConsent.exists }
        expectation(for: ready, evaluatedWith: nil)
        waitForExpectations(timeout: timeout)
        if consent.exists { consent.tap() }
        else if appConsent.exists { appConsent.tap() }
        let start = app.buttons["Start a run"].firstMatch
        tap(start)
        XCTAssertTrue(app.webViews.textFields["Ticket number"].firstMatch.waitForExistence(timeout: timeout))
        XCTAssertTrue(app.webViews.buttons["Start next eligible ticket"].firstMatch.isEnabled)
        tap(app.buttons["Back"].firstMatch)
        XCTAssertTrue(start.waitForExistence(timeout: timeout))
        tap(queue)
        tap(app.buttons["Filter"].firstMatch)
        XCTAssertTrue(app.webViews.textFields["Find a ticket"].firstMatch.waitForExistence(timeout: timeout))
        tap(app.webViews.buttons["Close"].firstMatch)
        let ticket = app.links.matching(NSPredicate(format: "label BEGINSWITH %@", "Synthetic ticket APP-1")).firstMatch
        tap(ticket)
        tap(app.staticTexts["A finished blocker"].firstMatch)

        let back = app.buttons["Back"].firstMatch
        XCTAssertTrue(app.webViews.staticTexts["Synthetic ticket APP-90"].firstMatch.waitForExistence(timeout: timeout))
        tap(back)
        XCTAssertTrue(app.webViews.staticTexts["Synthetic ticket APP-1"].firstMatch.waitForExistence(timeout: timeout))
        tap(back)
        XCTAssertTrue(ticket.waitForExistence(timeout: timeout))
        XCTAssertTrue(queue.isSelected)
    }
}
