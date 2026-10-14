import AppKit
import XCTest
@testable import NarutoReceiver

final class FocusTests: XCTestCase {
    @MainActor
    func testClipboardPublishedOnlyAfterLeavingVDICanBeCollectedAcrossBlocks() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setString("old local clipboard", forType: .string)
        var reader = ClipboardReader(pasteboard: pasteboard)
        let vdi: pid_t = 100
        let localApp: pid_t = 200
        var frontmost: pid_t? = vdi
        var pending: String?
        let focus = CommandTabFocusSwitch(targetPID: vdi, frontmostPID: { frontmost }, sendShortcut: {
            frontmost = frontmost == vdi ? localApp : vdi
            if frontmost == localApp, let pending {
                pasteboard.clearContents()
                pasteboard.setString(pending, forType: .string)
            }
        })
        // This local app is deliberately not Receiver. Leaving the VDI is sufficient.
        for block in ["metadata", "AAAA", "AAAA", "last block"] {
            try await focus.returnToTarget()
            XCTAssertEqual(frontmost, vdi, "Only the original VDI may receive the next click")
            pending = block
            try await focus.leaveTarget()
            XCTAssertEqual(frontmost, localApp)
            let received = try await reader.nextText(timeout: 0.5)
            XCTAssertEqual(received, block)
        }
    }

    @MainActor
    func testWrongAppOnReturnFailsWithoutCyclingThroughMoreApps() async throws {
        var frontmost: pid_t? = 200
        var shortcuts = 0
        let focus = CommandTabFocusSwitch(targetPID: 100, frontmostPID: { frontmost }, sendShortcut: {
            shortcuts += 1
            frontmost = 300
        }, timeout: 0.05)
        do {
            try await focus.returnToTarget()
            XCTFail("Returning to another application must not allow the next export click")
        } catch { XCTAssertFalse(error is CancellationError) }
        XCTAssertEqual(shortcuts, 1)
    }

    @MainActor
    func testUnknownForegroundDoesNotConfirmVDIFocusLoss() async throws {
        var frontmost: pid_t? = 100
        let focus = CommandTabFocusSwitch(targetPID: 100, frontmostPID: { frontmost }, sendShortcut: {
            frontmost = nil
        }, timeout: 0.05)
        do {
            try await focus.leaveTarget()
            XCTFail("A known different foreground application is required")
        } catch { XCTAssertFalse(error is CancellationError) }
    }

    @MainActor
    func testFocusWaitCanBeCancelledWhenShortcutIsIgnored() async throws {
        var shortcuts = 0
        let focus = CommandTabFocusSwitch(targetPID: 100, frontmostPID: { 100 }, sendShortcut: {
            shortcuts += 1
        })
        let task = Task { try await focus.leaveTarget() }
        try await Task.sleep(nanoseconds: 80_000_000)
        task.cancel()
        do {
            try await task.value
            XCTFail("Focus waiting must respect cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(shortcuts, 1)
    }
}
