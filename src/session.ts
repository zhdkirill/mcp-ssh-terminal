import { spawn } from "node-pty";
import type { IPty } from "node-pty";
// @xterm/headless is a CJS bundle whose named exports are not statically
// detectable by Node's ESM loader, so import the default and destructure.
import xtermPkg from "@xterm/headless";
import type { Terminal as TerminalInstance } from "@xterm/headless";
const { Terminal } = xtermPkg;

export interface SessionOptions {
  /** The command to run (usually "ssh"). */
  file: string;
  /** Arguments for the command. */
  args: string[];
  cols: number;
  rows: number;
  /** Human-readable label describing the destination, for listings. */
  label: string;
  /** Lines of scrollback the emulator retains. */
  scrollback?: number;
}

export interface RenderResult {
  text: string;
  cursorRow: number;
  cursorCol: number;
  rows: number;
  cols: number;
  totalLines: number;
  shownLines: number;
}

export type WaitReason = "idle" | "timeout" | "exited" | "data" | "quiet";

export interface WaitResult {
  reason: WaitReason;
}

// Measured in UTF-16 code units (== bytes for ASCII terminal traffic).
const MAX_RAW_BYTES = 512 * 1024;

/**
 * One persistent child process (typically the ssh client) attached to a PTY,
 * with its output fed into a headless xterm emulator so callers can read a
 * rendered screen instead of a raw escape-code stream.
 */
export class Session {
  readonly id: string;
  readonly label: string;
  readonly startedAt = Date.now();

  private pty: IPty;
  private term: TerminalInstance;
  private raw = "";
  private lastDataAt = Date.now();
  /** Bumped only by child output, never by our own writes. */
  private dataEvents = 0;
  private _exited = false;
  private _exitCode: number | null = null;
  private _exitSignal: number | null = null;

  constructor(id: string, opts: SessionOptions) {
    this.id = id;
    this.label = opts.label;

    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? 5000,
      allowProposedApi: true,
    });

    this.pty = spawn(opts.file, opts.args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });

    this.pty.onData((data: string) => {
      this.lastDataAt = Date.now();
      this.dataEvents++;
      this.term.write(data);
      this.raw += data;
      if (this.raw.length > MAX_RAW_BYTES) {
        this.raw = this.raw.slice(this.raw.length - MAX_RAW_BYTES);
      }
    });

    // The emulator generates replies to terminal queries from the remote side
    // (cursor-position reports, device attributes, ...). They must be written
    // back to the child, or programs that probe the terminal hang waiting.
    // This fires from xterm's async parse loop — outside any tool-call
    // try/catch — so a write to a just-died PTY must not crash the server.
    this.term.onData((data: string) => {
      if (this._exited) return;
      try {
        this.pty.write(data);
      } catch {
        /* pty torn down between the exit and onExit firing */
      }
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this._exited = true;
      this._exitCode = exitCode;
      this._exitSignal = signal ?? null;
      this.lastDataAt = Date.now();
    });
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get exitSignal(): number | null {
    return this._exitSignal;
  }

  get pid(): number {
    return this.pty.pid;
  }

  get dimensions(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /** True while the remote app has DECCKM (application cursor keys) enabled. */
  get applicationCursorKeys(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /** Write raw bytes to the PTY. Marks activity so idle-waits behave. */
  write(data: string): void {
    if (this._exited) throw new Error(`Session ${this.id} has exited`);
    this.lastDataAt = Date.now();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this._exited) throw new Error(`Session ${this.id} has exited`);
    this.pty.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  /**
   * Wait until the output has been quiet for `settleMs`, or `timeoutMs`
   * elapses, or the process exits — whichever comes first. This is how we
   * decide a command's output has "settled" enough to read.
   *
   * With `requireData`, the settle clock only counts once the child has
   * produced at least one byte of output — so a slow connection (DNS, TCP,
   * key exchange) isn't mistaken for an already-settled screen.
   */
  waitForIdle(settleMs: number, timeoutMs: number, requireData = false): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<WaitResult>((resolve) => {
      const tick = () => {
        if (this._exited) return resolve({ reason: "exited" });
        const now = Date.now();
        if (requireData && this.dataEvents === 0) {
          if (now >= deadline) return resolve({ reason: "timeout" });
          return void setTimeout(tick, Math.max(10, Math.min(50, deadline - now)));
        }
        const quietFor = now - this.lastDataAt;
        if (quietFor >= settleMs) return resolve({ reason: "idle" });
        if (now >= deadline) return resolve({ reason: "timeout" });
        const nextQuiet = this.lastDataAt + settleMs - now;
        const nextDeadline = deadline - now;
        setTimeout(tick, Math.max(10, Math.min(nextQuiet, nextDeadline)));
      };
      setTimeout(tick, Math.max(10, Math.min(settleMs, timeoutMs)));
    });
  }

  /**
   * Wait for *new* child output (any byte after this call), the process
   * exiting, or `timeoutMs` — whichever comes first. Unlike waitForIdle, an
   * already-quiet session blocks here until something actually arrives.
   */
  waitForData(timeoutMs: number): Promise<WaitResult> {
    const baseline = this.dataEvents;
    const deadline = Date.now() + timeoutMs;
    return new Promise<WaitResult>((resolve) => {
      const tick = () => {
        if (this.dataEvents > baseline) return resolve({ reason: "data" });
        if (this._exited) return resolve({ reason: "exited" });
        const now = Date.now();
        if (now >= deadline) return resolve({ reason: "timeout" });
        setTimeout(tick, Math.max(10, Math.min(25, deadline - now)));
      };
      tick();
    });
  }

  /** Flush the xterm write queue so a subsequent render sees all output. */
  private flush(): Promise<void> {
    return new Promise<void>((resolve) => this.term.write("", () => resolve()));
  }

  /**
   * Render the emulated screen as text. Returns the tail of the buffer down
   * to the bottom of the viewport (not just the cursor line — full-screen
   * apps often leave the cursor mid-screen with content below it), capped at
   * `maxLines`. Trailing blank lines are trimmed. This collapses
   * redraws/colors/cursor moves into the plain text a human would see.
   */
  async render(maxLines: number): Promise<RenderResult> {
    await this.flush();
    const buf = this.term.buffer.active;
    let lastRow = Math.min(buf.baseY + this.term.rows - 1, buf.length - 1);
    const absCursorRow = buf.baseY + buf.cursorY;
    // Skip trailing blank viewport rows (typical after a full-screen app
    // exits) so a small maxLines window isn't spent on empty space — but
    // never trim above the cursor line.
    const isBlank = (i: number) => {
      const line = buf.getLine(i);
      return !line || line.translateToString(true) === "";
    };
    while (lastRow > absCursorRow && isBlank(lastRow)) lastRow--;
    const start = Math.max(0, lastRow - maxLines + 1);

    const lines: string[] = [];
    for (let i = start; i <= lastRow; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    // Cursor row relative to the returned text block (buf.cursorY is
    // viewport-relative and would drift when scrollback lines are shown).
    return {
      text: lines.join("\n"),
      cursorRow: Math.max(0, absCursorRow - start),
      cursorCol: buf.cursorX,
      rows: this.term.rows,
      cols: this.term.cols,
      totalLines: buf.length,
      shownLines: lines.length,
    };
  }

  /** Return the tail of the raw PTY byte stream (escape codes included). */
  rawTail(maxBytes: number): string {
    if (maxBytes >= this.raw.length) return this.raw;
    return this.raw.slice(this.raw.length - maxBytes);
  }

  /** Terminate the child. SIGHUP first; caller may escalate. */
  close(signal: string = "SIGHUP"): void {
    if (this._exited) return;
    try {
      this.pty.kill(signal);
    } catch {
      /* already gone */
    }
  }

  kill(): void {
    try {
      this.pty.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
