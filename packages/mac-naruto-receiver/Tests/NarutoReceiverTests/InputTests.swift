import XCTest
import AppKit
@testable import NarutoReceiver

final class InputTests: XCTestCase {
    @MainActor
    func testClipboardIgnoresStaleTextButAcceptsIdenticalNewWrites() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setString("AAAA", forType: .string)
        var reader = ClipboardReader(pasteboard: pasteboard)
        do {
            _ = try await reader.nextText(timeout: 0.1)
            XCTFail("Must wait for a new write instead of reading stale clipboard contents")
        } catch { XCTAssertFalse(error is CancellationError) }
        pasteboard.clearContents()
        pasteboard.setString("AAAA", forType: .string)
        let first = try await reader.nextText(timeout: 1)
        XCTAssertEqual(first, "AAAA")
        // A manual click can write again before the receiver starts its next wait.
        pasteboard.clearContents()
        pasteboard.setString("AAAA", forType: .string)
        let second = try await reader.nextText(timeout: 1)
        XCTAssertEqual(second, "AAAA")
    }

    @MainActor
    func testClipboardWaitsForTextAfterClearAndDelayedVDIWrite() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        var reader = ClipboardReader(pasteboard: pasteboard)
        pasteboard.clearContents()
        let writer = Task { @MainActor in
            try await Task.sleep(nanoseconds: 120_000_000)
            pasteboard.setString("VDI block", forType: .string)
        }
        let received = try await reader.nextText(timeout: 1)
        try await writer.value
        XCTAssertEqual(received, "VDI block")
    }

    @MainActor
    func testClipboardReceivesChangedTextWithoutOwnershipChange() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setString("old text", forType: .string)
        var reader = ClipboardReader(pasteboard: pasteboard)
        let revision = pasteboard.changeCount
        // VDI data can arrive under the existing pasteboard owner.
        pasteboard.setString("new remote text", forType: .string)
        XCTAssertEqual(pasteboard.changeCount, revision)
        let received = try await reader.nextText(timeout: 0.3)
        XCTAssertEqual(received, "new remote text")
        do {
            _ = try await reader.nextText(timeout: 0.1)
            XCTFail("Unchanged content must not be collected repeatedly")
        } catch { XCTAssertFalse(error is CancellationError) }
    }

    @MainActor
    func testClipboardReadsDelayedDataFromExistingOwner() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.declareTypes([.string], owner: nil)
        var reader = ClipboardReader(pasteboard: pasteboard)
        let revision = pasteboard.changeCount
        let writer = Task { @MainActor in
            try await Task.sleep(nanoseconds: 120_000_000)
            pasteboard.setString("delayed remote text", forType: .string)
            XCTAssertEqual(pasteboard.changeCount, revision)
        }
        let received = try await reader.nextText(timeout: 1)
        try await writer.value
        XCTAssertEqual(received, "delayed remote text")
    }

    @MainActor
    func testClipboardReadsUTF16Text() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        var reader = ClipboardReader(pasteboard: pasteboard)
        pasteboard.clearContents()
        pasteboard.setData("VDI 文本".data(using: .utf16), forType: .init("public.utf16-external-plain-text"))
        let received = try await reader.nextText(timeout: 0.3)
        XCTAssertEqual(received, "VDI 文本")
    }

    @MainActor
    func testManualWaitCanBeCancelledWithoutClipboardActivity() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let wait = Task { @MainActor in
            var reader = ClipboardReader(pasteboard: pasteboard)
            return try await reader.nextText(timeout: nil)
        }
        try await Task.sleep(nanoseconds: 120_000_000)
        wait.cancel()
        do {
            _ = try await wait.value
            XCTFail("Manual waiting must respect cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
    }

    @MainActor
    func testManualModeDoesNotNeedATargetOrAccessibilityPermission() async throws {
        let clicker = MouseClicker(mode: .manual, pace: .normal, point: .zero, target: nil)
        try await clicker.click()
    }
}
