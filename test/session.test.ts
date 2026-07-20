import { describe, it, expect, afterEach } from "vitest";
import { Session } from "../src/session.js";

// Integration tests against a real PTY running /bin/sh — this covers the
// timing (waitForIdle/waitForData) and rendering logic that unit tests can't.

let live: Session[] = [];

function sh(cmd: string): Session {
  const s = new Session("t", {
    file: "/bin/sh",
    args: ["-c", cmd],
    cols: 80,
    rows: 24,
    label: "test",
  });
  live.push(s);
  return s;
}

afterEach(() => {
  for (const s of live) s.kill();
  live = [];
});

describe("Session", () => {
  it("renders command output", async () => {
    const s = sh("echo hello-world; sleep 30");
    const wait = await s.waitForIdle(200, 5000, true);
    expect(wait.reason).toBe("idle");
    const r = await s.render(50);
    expect(r.text).toContain("hello-world");
  });

  it("reports exit code", async () => {
    const s = sh("exit 3");
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (s.exited) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    expect(s.exitCode).toBe(3);
    expect(() => s.write("x")).toThrow(/exited/);
  });

  it("waitForIdle with requireData does not settle on pre-output silence", async () => {
    const s = sh("sleep 1; echo late-output; sleep 30");
    const t0 = Date.now();
    const wait = await s.waitForIdle(150, 8000, true);
    expect(wait.reason).toBe("idle");
    // Without requireData this would have resolved after ~150ms of silence.
    expect(Date.now() - t0).toBeGreaterThan(800);
    const r = await s.render(50);
    expect(r.text).toContain("late-output");
  });

  it("waitForData blocks until new output arrives", async () => {
    const s = sh("sleep 0.5; echo ping; sleep 30");
    const wait = await s.waitForData(8000);
    expect(wait.reason).toBe("data");
  });

  it("waitForData times out on a quiet session", async () => {
    const s = sh("sleep 30");
    await s.waitForIdle(200, 2000); // let any startup output pass
    const wait = await s.waitForData(300);
    expect(wait.reason).toBe("timeout");
  });

  it("keeps content visible in a small maxLines window when the screen bottom is blank", async () => {
    const s = sh("printf 'window-line\\n'; sleep 30");
    await s.waitForIdle(200, 5000, true);
    const r = await s.render(3);
    expect(r.text).toContain("window-line");
  });

  it("renders content below the cursor", async () => {
    // Print two lines, then move the cursor up above them: the lines below
    // the cursor must still be visible in the render.
    const s = sh(`printf 'top-line\\nbottom-line\\n\\033[3A'; sleep 30`);
    await s.waitForIdle(200, 5000, true);
    const r = await s.render(50);
    expect(r.text).toContain("bottom-line");
  });

  it("answers cursor-position queries from the child", async () => {
    // The child asks the terminal where the cursor is (DSR 6n) and blocks on
    // the reply; without the emulator->pty wiring this test hangs.
    const s = sh(
      `stty raw -echo; printf '\\033[6n'; reply=$(dd bs=1 count=6 2>/dev/null | od -An -c); ` +
        `stty sane; printf '\\nREPLY:%s\\n' "$reply"; sleep 30`
    );
    await s.waitForIdle(300, 8000, true);
    const r = await s.render(50);
    expect(r.text).toContain("REPLY:");
    expect(r.text).toContain("033"); // the ESC byte of the CPR response, as od renders it
  });
});
