import { describe, it, expect } from "vitest";
import { resolveKey, resolveKeys } from "../src/keys.js";

describe("resolveKey", () => {
  it("maps control chords Ctrl-A..Ctrl-Z to 0x01..0x1a", () => {
    expect(resolveKey("C-a")).toBe("\x01");
    expect(resolveKey("C-c")).toBe("\x03"); // Ctrl-C / SIGINT
    expect(resolveKey("C-x")).toBe("\x18"); // Ctrl-X (explicit requirement)
    expect(resolveKey("C-z")).toBe("\x1a");
    expect(resolveKey("Ctrl-d")).toBe("\x04");
    expect(resolveKey("control-l")).toBe("\x0c");
    expect(resolveKey("^u")).toBe("\x15");
  });

  it("maps C0 punctuation control chords", () => {
    expect(resolveKey("C-[")).toBe("\x1b"); // ESC
    expect(resolveKey("C-@")).toBe("\x00");
    expect(resolveKey("C-\\")).toBe("\x1c");
    expect(resolveKey("C-?")).toBe("\x7f");
  });

  it("maps named keys to xterm sequences", () => {
    expect(resolveKey("Enter")).toBe("\r");
    expect(resolveKey("Tab")).toBe("\t");
    expect(resolveKey("Escape")).toBe("\x1b");
    expect(resolveKey("Backspace")).toBe("\x7f");
    expect(resolveKey("Up")).toBe("\x1b[A");
    expect(resolveKey("Down")).toBe("\x1b[B");
    expect(resolveKey("Right")).toBe("\x1b[C");
    expect(resolveKey("Left")).toBe("\x1b[D");
    expect(resolveKey("F5")).toBe("\x1b[15~");
    expect(resolveKey("Delete")).toBe("\x1b[3~");
  });

  it("is case-insensitive for names", () => {
    expect(resolveKey("ENTER")).toBe("\r");
    expect(resolveKey("tab")).toBe("\t");
  });

  it("handles Alt/Meta chords as ESC-prefixed", () => {
    expect(resolveKey("M-b")).toBe("\x1bb");
    expect(resolveKey("Alt-f")).toBe("\x1bf");
  });

  it("decodes hex tokens", () => {
    expect(resolveKey("hex:1b5b41")).toBe("\x1b[A");
    expect(resolveKey("hex:03")).toBe("\x03");
  });

  it("throws on malformed hex", () => {
    expect(() => resolveKey("hex:zz")).toThrow();
    expect(() => resolveKey("hex:1")).toThrow();
  });

  it("passes single characters through as literals", () => {
    expect(resolveKey("y")).toBe("y");
    expect(resolveKey("Q")).toBe("Q");
    expect(resolveKey("🙂")).toBe("🙂"); // one code point, two UTF-16 units
  });

  it("throws on unrecognised multi-character tokens instead of typing them", () => {
    expect(() => resolveKey("hello")).toThrow(/Unrecognised key token/);
    expect(() => resolveKey("ctrl+c")).toThrow(); // typo'd chord (plus, not dash)
    expect(() => resolveKey("Ctlr-c")).toThrow();
  });

  it("emits SS3 cursor sequences in application cursor-keys mode", () => {
    expect(resolveKey("Up", { applicationCursorKeys: true })).toBe("\x1bOA");
    expect(resolveKey("Left", { applicationCursorKeys: true })).toBe("\x1bOD");
    expect(resolveKey("End", { applicationCursorKeys: true })).toBe("\x1bOF");
    expect(resolveKey("Up", { applicationCursorKeys: false })).toBe("\x1b[A");
    // Non-cursor keys are unaffected by the mode.
    expect(resolveKey("F5", { applicationCursorKeys: true })).toBe("\x1b[15~");
  });

  it("resolveKeys concatenates in order", () => {
    expect(resolveKeys(["l", "s", "Enter"])).toBe("ls\r");
    expect(resolveKeys(["C-c", "Enter"])).toBe("\x03\r");
  });
});
