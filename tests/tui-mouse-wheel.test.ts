import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMouseReport, parseMouseWheelDirection } from "../src/tui/mouseWheel.js";

describe("mouseWheel", () => {
  it("parses SGR wheel events with and without leading ESC (Ink strips ESC)", () => {
    // Raw terminal bytes
    assert.equal(parseMouseWheelDirection("\u001B[<64;10;20M"), 1);
    assert.equal(parseMouseWheelDirection("\u001B[<65;10;20m"), -1);
    // What Ink's useInput actually delivers
    assert.equal(parseMouseWheelDirection("[<64;12;8M"), 1);
    assert.equal(parseMouseWheelDirection("[<65;12;8M"), -1);
    // Modifier flags on wheel (shift/meta/ctrl bits)
    assert.equal(parseMouseWheelDirection("[<68;1;1M"), 1); // 64|4
    assert.equal(parseMouseWheelDirection("[<81;1;1M"), -1); // 65|16
  });

  it("parses X10 legacy wheel events", () => {
    // button 64/65 encoded as charCode = button + 32
    const wheelUp = `[M${String.fromCharCode(64 + 32)}!!`;
    const wheelDown = `[M${String.fromCharCode(65 + 32)}!!`;
    assert.equal(parseMouseWheelDirection(wheelUp), 1);
    assert.equal(parseMouseWheelDirection(wheelDown), -1);
    assert.equal(parseMouseWheelDirection(`\u001B${wheelUp}`), 1);
  });

  it("ignores non-wheel mouse clicks for direction but still recognizes reports", () => {
    assert.equal(parseMouseWheelDirection("[<0;10;20M"), undefined);
    assert.equal(parseMouseWheelDirection("[<32;10;20M"), undefined);
    assert.equal(isMouseReport("[<0;10;20M"), true);
    assert.equal(isMouseReport("[<64;10;20M"), true);
    assert.equal(isMouseReport("\u001B[<65;1;1M"), true);
    assert.equal(isMouseReport("[M@!!"), true);
  });

  it("does not treat normal typing as mouse input", () => {
    assert.equal(isMouseReport("hello"), false);
    assert.equal(isMouseReport("[not-mouse"), false);
    assert.equal(isMouseReport(""), false);
    assert.equal(parseMouseWheelDirection("hello"), undefined);
    assert.equal(parseMouseWheelDirection("a"), undefined);
  });
});
