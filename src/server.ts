import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager, buildSshCommand } from "./manager.js";
import type { Session, RenderResult, WaitReason } from "./session.js";
import { resolveKeys } from "./keys.js";
import { listConfigHosts } from "./sshConfig.js";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

// Settle/timeout defaults (ms). Connecting allows more time for banners,
// host-key prompts, and multi-hop ProxyJump handshakes.
const CONNECT_SETTLE = 700;
const CONNECT_TIMEOUT = 20000;
const SEND_SETTLE = 500;
const SEND_TIMEOUT = 12000;
const DEFAULT_MAX_LINES = 200;

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function text(s: string): TextResult {
  return { content: [{ type: "text", text: s }] };
}

function errorText(s: string): TextResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

/** Compose the standard status footer shown after a screen render. */
function statusLine(session: Session, wait: WaitReason, render: RenderResult): string {
  const parts: string[] = [];
  parts.push(`session=${session.id}`);
  if (session.exited) {
    const code = session.exitCode;
    const sig = session.exitSignal;
    parts.push(`state=exited${code !== null ? ` code=${code}` : ""}${sig ? ` signal=${sig}` : ""}`);
  } else {
    parts.push("state=live");
  }
  parts.push(`wait=${wait}`);
  parts.push(`cursor=${render.cursorRow + 1},${render.cursorCol + 1}`);
  parts.push(`screen=${render.rows}x${render.cols}`);
  parts.push(`shown=${render.shownLines}/${render.totalLines}`);
  return `[${parts.join(" | ")}]`;
}

function screenBlock(render: RenderResult, session: Session, wait: WaitReason): string {
  const body = render.text.length > 0 ? render.text : "(no output yet)";
  const hint =
    wait === "timeout" && !session.exited
      ? "\n(output still arriving — call ssh_read again to see more, or wait longer)"
      : wait === "quiet"
        ? "\n(no new output arrived within waitMs — the program may be running quietly or awaiting input)"
        : "";
  return `${body}\n${statusLine(session, wait, render)}${hint}`;
}

// Zod bounds: generous enough for any real terminal, tight enough that a
// bogus value can't allocate a gigantic emulator buffer or hang a call.
const colsSchema = z.number().int().min(10).max(1000);
const rowsSchema = z.number().int().min(4).max(500);
const settleSchema = z.number().int().nonnegative().max(60_000);
const timeoutSchema = z.number().int().positive().max(600_000);
const maxLinesSchema = z.number().int().positive().max(5000);

export function createServer(manager: SessionManager): McpServer {
  const server = new McpServer(
    {
      name: "mcp-ssh-terminal",
      version: "0.2.0",
    },
    {
      instructions: [
        "Persistent, interactive SSH sessions over the real OpenSSH client.",
        "",
        "How it works: each session is a live `ssh` process attached to a PTY, with",
        "output rendered through a terminal emulator so you read the screen a human",
        "would see. Sessions stay open across tool calls — connect once, then send",
        "input and read output repeatedly.",
        "",
        "Config, keys, known_hosts, and ProxyJump are all handled by ssh itself, so",
        "~/.ssh/config Host aliases, IdentityFile, and multi-hop jumps 'just work'.",
        "",
        "Typical flow:",
        "  1. ssh_connect { host } -> returns a session id and the initial screen.",
        "  2. If a password / passphrase / host-key prompt appears on the screen,",
        "     answer it with ssh_send (e.g. type the password, or send 'yes').",
        "  3. ssh_send { session, text: 'command', appendEnter: true } to run a command.",
        "  4. ssh_read to poll long-running output; ssh_interrupt for Ctrl-C.",
        "",
        "Control characters & special keys: use the `keys` array on ssh_send, e.g.",
        "['C-c'] for Ctrl-C, ['C-x'] for Ctrl-X, ['Up'], ['Tab'], ['Escape'], ['F5'].",
        "",
        "Works with non-Unix shells (e.g. Mikrotik RouterOS): it is a faithful",
        "terminal, so interactive CLIs, tab-completion, and paging behave normally.",
        "",
        "Mikrotik RouterOS tips:",
        "  - '?' and Tab are live hotkeys in the RouterOS console (inline help /",
        "    completion) — they act immediately, so avoid them inside `text` unless",
        "    intended. Prefer single-line commands; multi-line pastes get mangled",
        "    by the console's auto-indent.",
        "  - Long `print` output pauses on a pager line ('-- [Q quit|D dump|down]'):",
        "    answer via ssh_send ('D' dumps all, 'Q' quits, Space pages), or run",
        "    `print without-paging` in the first place.",
        "  - Ctrl-X (keys: ['C-x']) toggles RouterOS Safe Mode: enter it before",
        "    config changes so they auto-revert if the session drops; press it",
        "    again to commit. Don't send it casually.",
      ].join("\n"),
    }
  );

  server.registerTool(
    "ssh_connect",
    {
      title: "Open SSH session",
      description:
        "Open a persistent interactive SSH session to a host and return the initial screen. " +
        "`host` may be an ~/.ssh/config Host alias, a hostname, or user@hostname. Config, " +
        "key auth, known_hosts, and ProxyJump are delegated to the ssh client. If a password, " +
        "passphrase, 2FA, or host-key prompt appears in the returned screen, respond with ssh_send.",
      inputSchema: {
        host: z.string().min(1).describe("Destination: ssh_config Host alias, hostname, or user@hostname"),
        user: z.string().optional().describe("Username (prepended as user@host if host has no '@')"),
        port: z.number().int().min(1).max(65535).optional().describe("Port (ssh -p); usually unnecessary if set in config"),
        identityFile: z.string().optional().describe("Private key path (ssh -i); ~ is expanded"),
        jump: z
          .string()
          .optional()
          .describe("ProxyJump chain (ssh -J), e.g. 'bastion' or 'userA@a,userB@b' for A->B->C"),
        remoteCommand: z
          .string()
          .optional()
          .describe("Run this command instead of an interactive login shell (still on a PTY)"),
        extraArgs: z.array(z.string()).optional().describe("Extra raw ssh arguments appended verbatim"),
        forceTty: z.boolean().optional().describe("Force remote PTY allocation (ssh -tt). Default true"),
        cols: colsSchema.optional().describe(`Terminal width (default ${DEFAULT_COLS})`),
        rows: rowsSchema.optional().describe(`Terminal height (default ${DEFAULT_ROWS})`),
        settleMs: settleSchema.optional().describe(`Idle-quiet threshold before reading (default ${CONNECT_SETTLE})`),
        timeoutMs: timeoutSchema.optional().describe(`Max wait for initial screen (default ${CONNECT_TIMEOUT})`),
        maxLines: maxLinesSchema.optional().describe(`Max screen lines to return (default ${DEFAULT_MAX_LINES})`),
      },
    },
    async (a) => {
      try {
        const cols = a.cols ?? DEFAULT_COLS;
        const rows = a.rows ?? DEFAULT_ROWS;
        const cmd = buildSshCommand({
          host: a.host,
          user: a.user,
          port: a.port,
          identityFile: a.identityFile,
          jump: a.jump,
          remoteCommand: a.remoteCommand,
          extraArgs: a.extraArgs,
          forceTty: a.forceTty,
        });
        const session = manager.create(cmd, cols, rows);
        // requireData: the settle clock starts at the first byte of output, so
        // a slow DNS/TCP/kex phase isn't misread as an already-settled screen.
        const wait = await session.waitForIdle(a.settleMs ?? CONNECT_SETTLE, a.timeoutMs ?? CONNECT_TIMEOUT, true);
        const render = await session.render(a.maxLines ?? DEFAULT_MAX_LINES);
        const header = `Connecting: ssh ${cmd.args.join(" ")}\n`;
        const noOutputHint =
          session.exited && render.text.length === 0
            ? "\n(ssh exited immediately with no output — is the OpenSSH client installed and on PATH?)"
            : "";
        return text(header + screenBlock(render, session, wait.reason) + noOutputHint);
      } catch (err) {
        return errorText(`ssh_connect failed: ${(err as Error).message}`);
      }
    }
  );

  server.registerTool(
    "ssh_send",
    {
      title: "Send input to SSH session",
      description:
        "Send text and/or special keys to a session, wait for the output to settle, and return the " +
        "updated screen. Use `text` for literal typing, `keys` for control chars and special keys " +
        "(e.g. ['C-c'], ['Up'], ['Tab'], ['Escape']), and `appendEnter` to press Enter after the text. " +
        "Order sent: text, then keys, then (if set) Enter.",
      inputSchema: {
        session: z.string().min(1).describe("Session id from ssh_connect"),
        text: z.string().optional().describe("Literal text to type (control chars are not interpreted here)"),
        keys: z
          .array(z.string())
          .optional()
          .describe(
            "Ordered key tokens: 'Enter','Tab','Escape','Up','Down','F5','C-c'(Ctrl-C),'C-x','M-b'(Alt-b),'hex:1b', " +
              "or a single literal character. Unknown multi-character tokens are rejected — literal text goes in `text`."
          ),
        appendEnter: z.boolean().optional().describe("Press Enter after text/keys (convenience for running a command)"),
        settleMs: settleSchema.optional().describe(`Idle-quiet threshold (default ${SEND_SETTLE})`),
        timeoutMs: timeoutSchema.optional().describe(`Max wait for output (default ${SEND_TIMEOUT})`),
        maxLines: maxLinesSchema.optional().describe(`Max screen lines to return (default ${DEFAULT_MAX_LINES})`),
      },
    },
    async (a) => {
      try {
        const session = manager.require(a.session);
        if (session.exited) return errorText(`Session ${session.id} has exited and cannot receive input.`);

        let payload = "";
        if (a.text !== undefined) payload += a.text;
        if (a.keys && a.keys.length > 0) {
          payload += resolveKeys(a.keys, { applicationCursorKeys: session.applicationCursorKeys });
        }
        if (a.appendEnter) payload += "\r";
        if (payload.length === 0) {
          return errorText("Nothing to send: provide `text`, `keys`, and/or `appendEnter`.");
        }

        session.write(payload);
        const wait = await session.waitForIdle(a.settleMs ?? SEND_SETTLE, a.timeoutMs ?? SEND_TIMEOUT);
        const render = await session.render(a.maxLines ?? DEFAULT_MAX_LINES);
        return text(screenBlock(render, session, wait.reason));
      } catch (err) {
        return errorText(`ssh_send failed: ${(err as Error).message}`);
      }
    }
  );

  server.registerTool(
    "ssh_read",
    {
      title: "Read SSH screen",
      description:
        "Read the current session screen without sending input. Use this to poll output from a " +
        "long-running command. Set `waitMs` to block until new output actually arrives (or the " +
        "session exits, or `waitMs` elapses) before reading.",
      inputSchema: {
        session: z.string().min(1).describe("Session id"),
        mode: z.enum(["screen", "raw"]).optional().describe("'screen' = rendered text (default); 'raw' = raw byte stream with escape codes"),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(600_000)
          .optional()
          .describe("Block up to this long for NEW output before reading; footer shows wait=quiet if nothing arrived (default 0 = read immediately)"),
        maxLines: maxLinesSchema.optional().describe(`Max screen lines (screen mode; default ${DEFAULT_MAX_LINES})`),
        maxBytes: z.number().int().positive().max(524_288).optional().describe("Max bytes (raw mode; default 8192)"),
      },
    },
    async (a) => {
      try {
        const session = manager.require(a.session);
        let wait: WaitReason = "idle";
        if (a.waitMs && a.waitMs > 0) {
          // Block for genuinely new output, then let it settle briefly so the
          // render isn't a half-written line. Reasons surfaced to the caller:
          //   idle    — new output arrived and settled
          //   timeout — new output arrived and is still streaming
          //   quiet   — nothing new arrived within waitMs
          //   exited  — the session ended while waiting
          const first = await session.waitForData(a.waitMs);
          if (first.reason === "data") {
            wait = (await session.waitForIdle(Math.min(300, a.waitMs), 1000)).reason;
          } else if (first.reason === "timeout") {
            wait = "quiet";
          } else {
            wait = first.reason;
          }
        }
        if (a.mode === "raw") {
          const raw = session.rawTail(a.maxBytes ?? 8192);
          return text(`${JSON.stringify(raw)}\n[session=${session.id} | state=${session.exited ? "exited" : "live"} | rawBytes=${raw.length}]`);
        }
        const render = await session.render(a.maxLines ?? DEFAULT_MAX_LINES);
        return text(screenBlock(render, session, wait));
      } catch (err) {
        return errorText(`ssh_read failed: ${(err as Error).message}`);
      }
    }
  );

  server.registerTool(
    "ssh_interrupt",
    {
      title: "Send Ctrl-C",
      description: "Send Ctrl-C (SIGINT) to the foreground program in a session, then return the updated screen.",
      inputSchema: {
        session: z.string().min(1).describe("Session id"),
        settleMs: settleSchema.optional(),
        timeoutMs: timeoutSchema.optional(),
        maxLines: maxLinesSchema.optional(),
      },
    },
    async (a) => {
      try {
        const session = manager.require(a.session);
        if (session.exited) return errorText(`Session ${session.id} has already exited.`);
        session.write("\x03");
        const wait = await session.waitForIdle(a.settleMs ?? SEND_SETTLE, a.timeoutMs ?? SEND_TIMEOUT);
        const render = await session.render(a.maxLines ?? DEFAULT_MAX_LINES);
        return text(screenBlock(render, session, wait.reason));
      } catch (err) {
        return errorText(`ssh_interrupt failed: ${(err as Error).message}`);
      }
    }
  );

  server.registerTool(
    "ssh_resize",
    {
      title: "Resize terminal",
      description: "Change the terminal dimensions of a session (affects line wrapping and full-screen apps).",
      inputSchema: {
        session: z.string().min(1).describe("Session id"),
        cols: colsSchema.describe("New column count"),
        rows: rowsSchema.describe("New row count"),
      },
    },
    async (a) => {
      try {
        const session = manager.require(a.session);
        session.resize(a.cols, a.rows);
        return text(`Resized ${session.id} to ${a.cols}x${a.rows}.`);
      } catch (err) {
        return errorText(`ssh_resize failed: ${(err as Error).message}`);
      }
    }
  );

  server.registerTool(
    "ssh_list",
    {
      title: "List SSH sessions",
      description: "List all active SSH sessions with their destination, state, and age.",
      inputSchema: {},
    },
    async () => {
      const sessions = manager.list();
      if (sessions.length === 0) return text("No active sessions.");
      const lines = sessions.map((s) => {
        const ageSec = Math.round((Date.now() - s.startedAt) / 1000);
        const state = s.exited ? `exited(code=${s.exitCode ?? "?"})` : "live";
        const { cols, rows } = s.dimensions;
        return `${s.id}\t${state}\t${cols}x${rows}\tpid=${s.pid}\tage=${ageSec}s\t${s.label}`;
      });
      return text(`Active sessions (${sessions.length}):\n${lines.join("\n")}`);
    }
  );

  server.registerTool(
    "ssh_disconnect",
    {
      title: "Close SSH session",
      description: "Close a session and terminate its ssh process.",
      inputSchema: {
        session: z.string().min(1).describe("Session id to close"),
      },
    },
    async (a) => {
      const ok = manager.remove(a.session);
      return ok ? text(`Closed session ${a.session}.`) : errorText(`Unknown session "${a.session}".`);
    }
  );

  server.registerTool(
    "ssh_config_hosts",
    {
      title: "List ssh_config hosts",
      description:
        "List Host aliases from ~/.ssh/config (best-effort, follows Include) for discovery. " +
        "Connection semantics are always resolved by the ssh client, not this listing.",
      inputSchema: {
        configPath: z.string().optional().describe("Alternate config path (default ~/.ssh/config)"),
      },
    },
    async (a) => {
      try {
        const hosts = listConfigHosts(a.configPath);
        if (hosts.length === 0) return text("No Host entries found in ssh config.");
        const lines = hosts.map((h) => {
          const bits: string[] = [];
          if (h.hostName) bits.push(`hostname=${h.hostName}`);
          if (h.user) bits.push(`user=${h.user}`);
          if (h.port) bits.push(`port=${h.port}`);
          if (h.proxyJump) bits.push(`jump=${h.proxyJump}`);
          const detail = bits.length ? `  (${bits.join(", ")})` : "";
          return `${h.patterns.join(" ")}${detail}`;
        });
        return text(`Host aliases (${hosts.length}):\n${lines.join("\n")}`);
      } catch (err) {
        return errorText(`ssh_config_hosts failed: ${(err as Error).message}`);
      }
    }
  );

  return server;
}
