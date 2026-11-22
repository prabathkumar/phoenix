import XCTest
@testable import Demo
final class CalcTests: XCTestCase {
    func testAddUnit() { XCTAssertEqual(add(1, 2), 3) }
    func testAddIntegration() { XCTAssertEqual(add(add(1, 2), add(3, 4)), 10) }
}
