# mcp-ssh-terminal

[![npm](https://img.shields.io/npm/v/mcp-ssh-terminal)](https://www.npmjs.com/package/mcp-ssh-terminal)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blueviolet)](https://modelcontextprotocol.io)

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent **persistent, fully interactive SSH sessions** — a real shell into a remote host that behaves as if you were typing at a local terminal.

- **Sessions persist across tool calls** — connect once, run commands, inspect output, run more; state (working directory, environment, running programs) is preserved.
- **A real terminal, not a command runner** — arbitrary control characters (Ctrl-C, Ctrl-X, arrows, Tab, function keys) pass through faithfully, so interactive TUIs, pagers, tab-completion, and prompts all work.
- **Non-Unix CLIs work too** — network appliances like **Mikrotik RouterOS** are first-class citizens because the session is a genuine PTY.
- **Your existing SSH setup just works** — `~/.ssh/config` aliases, `IdentityFile`, ssh-agent, `ProxyJump` chains, and known_hosts are all handled by the real OpenSSH client, untouched.

```text
ssh_connect { "host": "prod-web" }                                → s1 + login screen
ssh_send    { "session": "s1", "text": "htop", "appendEnter": true }
ssh_send    { "session": "s1", "keys": ["F5"] }                   → tree view, rendered
ssh_interrupt { "session": "s1" }                                 → Ctrl-C, back to prompt
```

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Register with an MCP client](#register-with-an-mcp-client)
- [Docker](#docker-optional)
- [Tools](#tools)
- [Special keys](#special-keys-for-ssh_send)
- [Usage walkthroughs](#usage-walkthroughs)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## How it works

### Decision 1: drive the real OpenSSH client (`ssh`) inside a PTY

Rather than reimplementing SSH in JavaScript, each session spawns your actual `ssh` binary attached to a pseudo-terminal. Every connection requirement you'd otherwise have to hand-build is something OpenSSH already does correctly:

| Requirement | How it's satisfied |
| --- | --- |
| Honor `~/.ssh/config` | `ssh` reads it natively — `Host` aliases, `IdentityFile`, `Match`, `Include`, everything. No config parsing of our own is in the connection path. |
| ProxyJump A → B → C | `ProxyJump` in your config, or the `jump` argument (`ssh -J`), handled entirely by `ssh`. |
| known_hosts verification | `ssh`'s default `StrictHostKeyChecking` behavior is left intact. A new host's fingerprint prompt appears on the screen; you approve it with `ssh_send` (`yes`). |
| Key-based auth | `ssh` uses your `IdentityFile`, ssh-agent, encrypted keys, FIDO tokens — unchanged. Passphrase/password/2FA prompts surface on the screen and you answer them with `ssh_send`. |
| Arbitrary control characters | The child runs on a PTY, so raw bytes (0x00–0x1F, 0x7F, escape sequences) reach the remote program exactly. The ssh escape char is disabled (`-e none`) so nothing is intercepted. |
| Non-Unix shells (RouterOS) | Because it's a faithful terminal (PTY + `-tt` to force a remote PTY), interactive CLIs, paging, and tab-completion behave normally. |
| Uninterrupted sessions | The `ssh` process is long-lived and tracked by session id; you connect once and interact repeatedly. Keepalives (`ServerAliveInterval=30`, `ServerAliveCountMax=3`) are set by default so NAT/conntrack doesn't silently drop idle sessions; override via `extraArgs`. |

A pure-JS library (e.g. `ssh2`) would force us to re-implement ssh_config resolution, `Match` logic, ProxyJump chaining, known_hosts hashing/verification, and key handling — a large, security-sensitive surface that OpenSSH already gets right. Delegating to `ssh` means the server behaves **exactly like your own `ssh <host>` command**.

### Decision 2: a headless terminal emulator for reading output

Raw PTY output is a byte stream full of cursor moves, colors, and redraws. Feeding that to an agent is unreadable. So output is piped through [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless), which maintains a virtual screen. Tools return the **rendered screen a human would see** — redraws collapsed to their final state, escape codes resolved to plain text. (A `raw` mode is still available on `ssh_read` when you need the underlying bytes.) The emulator also answers terminal queries from the remote side (cursor-position reports, device attributes), so programs that probe the terminal don't hang.

### How "is the output done?" is decided

After input is sent, the server waits until output has been **quiet for `settleMs`** (default 500 ms) or a `timeoutMs` cap is hit, then renders. A long-running command returns partial output at the timeout with a hint to call `ssh_read` again — no output is lost, and short commands feel snappy.

### Terminal multiplexing

Two levels:

- **Multiple concurrent sessions** — connect to many hosts at once; each has its own session id (up to 32 concurrent).
- **tmux/screen inside a session** — since each session is a real terminal, you can run `tmux` on the remote host and drive it with control keys (`ssh_send { keys: ["C-b", "c"] }`, etc.).

## Requirements

- **Node.js ≥ 22** (`fs.glob`, used by the config lister, does not exist on Node 20)
- The **OpenSSH client** (`ssh`) on `PATH` — the same one your shell uses.
- macOS/Linux. (`node-pty` ships prebuilt binaries; on macOS the bundled `spawn-helper` must be executable — see [Troubleshooting](#troubleshooting).)

## Install

**From npm** — nothing to do up front; register it straight with `npx` (next section). Or install globally:

```bash
npm install -g mcp-ssh-terminal
```

**From source:**

```bash
git clone https://github.com/zhdkirill/mcp-ssh-terminal.git
cd mcp-ssh-terminal
npm install
npm run build      # compiles TypeScript to dist/
npm test           # optional: runs the tests (keys, argv builder, ssh_config, live PTY sessions)
```

## Register with an MCP client

**Claude Code (CLI):**

```bash
claude mcp add ssh -- npx -y mcp-ssh-terminal
# or, from a source checkout:
claude mcp add ssh -- node /path/to/mcp-ssh-terminal/dist/index.js
```

**Project-scoped `.mcp.json` or Claude Desktop config:**

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-ssh-terminal"]
    }
  }
}
```

(For a source checkout, use `"command": "node", "args": ["/path/to/mcp-ssh-terminal/dist/index.js"]` instead.)

The server speaks MCP over stdio. It writes nothing to stdout except protocol traffic (logs go to stderr), so it is safe to run under any stdio MCP host.

## Docker (optional)

**Run it natively if you can.** The whole design delegates auth to *your* OpenSSH — config, keys, agent, known_hosts — and a container sees none of that unless you mount it in. Docker is the right choice when the consuming machine shouldn't need Node, or you want a pinned, hermetic runtime; it is the wrong choice if you rely on ssh-agent, FIDO keys, or VPN-only routes that exist on the host.

```bash
docker build -t mcp-ssh-terminal .
```

Register (mounting your ssh config/keys read-only):

```bash
claude mcp add ssh -- docker run -i --rm --init -v "$HOME/.ssh:/home/node/.ssh:ro" mcp-ssh-terminal
```

Notes for container mode:

- **`-i` is mandatory** (stdio transport) and `--init` is recommended (proper PID-1 signal handling; the server also handles SIGTERM itself).
- **ssh-agent:** Linux: add `-v "$SSH_AUTH_SOCK:/agent.sock" -e SSH_AUTH_SOCK=/agent.sock`. Docker Desktop for Mac: `-v /run/host-services/ssh-auth.sock:/agent.sock -e SSH_AUTH_SOCK=/agent.sock`. Without an agent, mounted key files still work (you'll type passphrases interactively via `ssh_send`).
- **known_hosts:** with a read-only mount, newly-accepted host keys can't be persisted — ssh warns and continues for that session. Mount `~/.ssh` read-write (or a dedicated known_hosts file) if you want them remembered.
- **File ownership:** the image runs as the `node` user (uid 1000). If your bind-mounted keys come through owned by a different uid and unreadable, add `--user root` (the container is ephemeral and has your keys mounted either way).
- **Networking:** the container has its own network namespace. Host-only routes (VPN tunnels, `localhost` targets) may need `--network host` (Linux only) or won't work as they do natively.

## Tools

| Tool | Purpose |
| --- | --- |
| `ssh_connect` | Open a session to a host. Returns a session id and the initial screen (prompt, or an auth/host-key prompt to answer). |
| `ssh_send` | Send `text` and/or special `keys` (and optional Enter), wait for output to settle, return the updated screen. |
| `ssh_read` | Read the current screen without sending — poll long-running output. Supports `mode: "raw"` and blocking for new output via `waitMs`. |
| `ssh_interrupt` | Send Ctrl-C to the foreground program. |
| `ssh_resize` | Change terminal dimensions (affects wrapping and full-screen apps). |
| `ssh_list` | List active sessions with state, pid, age, destination. |
| `ssh_disconnect` | Close a session and terminate its `ssh` process. |
| `ssh_config_hosts` | List `Host` aliases from `~/.ssh/config` (best-effort, follows `Include`) for discovery. |

### `ssh_connect` parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `host` | string, required | ssh_config `Host` alias, hostname, or `user@hostname` |
| `user` | string | Username (prepended as `user@host`) |
| `port` | number | Port (`ssh -p`); usually unnecessary if set in config |
| `identityFile` | string | Private key path (`ssh -i`); `~` is expanded |
| `jump` | string | ProxyJump chain (`ssh -J`), e.g. `"bastion"` or `"userA@a,userB@b"` |
| `remoteCommand` | string | Run this command instead of an interactive login shell (still on a PTY) |
| `extraArgs` | string[] | Extra raw ssh arguments appended verbatim |
| `forceTty` | boolean | Force remote PTY allocation (`ssh -tt`). Default `true` |
| `cols`, `rows` | number | Terminal size (default 120×40) |
| `settleMs`, `timeoutMs` | number | Output-settle threshold / max wait (defaults 700 / 20000) |
| `maxLines` | number | Max screen lines returned (default 200) |

Every screen-returning tool accepts `settleMs`, `timeoutMs`, and `maxLines`, and appends a status footer:

```text
[session=s1 | state=live | wait=idle | cursor=12,1 | screen=40x120 | shown=24/40]
```

`state` becomes `exited code=N` when the ssh process ends; `wait` tells you whether output settled (`idle`), was still streaming (`timeout`), or nothing new arrived (`quiet`).

## Special keys for `ssh_send`

Pass an ordered `keys` array. Recognised tokens (case-insensitive):

- **Control chords:** `C-c` (Ctrl-C), `C-x`, `Ctrl-d`, `^u`, `C-[` (Esc), `C-@` (NUL), `C-\`, `C-?` (DEL) — covers all of 0x00–0x1F and 0x7F.
- **Named keys:** `Enter`, `Tab`, `Backtab`, `Space`, `Escape`, `Backspace`, `Delete`, `Insert`, `Up`/`Down`/`Left`/`Right`, `Home`, `End`, `PageUp`, `PageDown`, `F1`–`F12`.
- **Alt/Meta:** `M-b`, `Alt-f`, `meta-.` → ESC-prefixed.
- **Raw bytes:** `hex:1b5b41` → arbitrary byte sequence.
- **Single characters:** `y`, `Q` → sent as-is.

Any other multi-character token is an **error** — a typo'd chord is rejected instead of being typed into the remote shell. Literal text belongs in `text`, not `keys`. Arrow/Home/End keys automatically switch to SS3 sequences when the remote app enables application cursor-keys mode (DECCKM), like a real terminal.

`text` is sent literally first, then `keys` in order, then Enter if `appendEnter: true`.

## Usage walkthroughs

**Basic:**
1. `ssh_connect { "host": "prod-web" }` → screen shows the shell prompt.
2. `ssh_send { "session": "s1", "text": "uname -a", "appendEnter": true }` → screen shows the output.
3. `ssh_disconnect { "session": "s1" }`.

**Mikrotik RouterOS:**
1. `ssh_connect { "host": "admin@192.0.2.1" }` → RouterOS banner + `[admin@MikroTik] >` prompt.
2. `ssh_send { "session": "s1", "text": "/interface print", "appendEnter": true }`.
3. Tab-completion: `ssh_send { "session": "s1", "text": "/ip ad", "keys": ["Tab"] }`.
4. Abort a running command: `ssh_interrupt { "session": "s1" }` (Ctrl-C), or send `Q` to quit a pager.

RouterOS console gotchas worth knowing:
- `?` and Tab are **live hotkeys** (inline help / completion) — they act the instant they arrive, so keep them out of `text` unless intended, and prefer single-line commands (multi-line pastes are mangled by auto-indent; use `/import` for scripts).
- Long `print` output stops at a pager line (`-- [Q quit|D dump|down]`): send `D` to dump the rest, or run `print without-paging`.
- `keys: ["C-x"]` toggles **Safe Mode** — enter it before config changes so they auto-revert if the session drops.

**ProxyJump A → B → C:** use a config alias that sets `ProxyJump`, and just `ssh_connect { "host": "internal-box" }`. Or set the chain inline: `ssh_connect { "host": "10.0.0.5", "jump": "bastionA,bastionB" }`.

**Answering auth / host-key prompts:** if the initial screen shows `Are you sure you want to continue connecting (yes/no)?`, reply `ssh_send { "session": "s1", "text": "yes", "appendEnter": true }`. For a password prompt, send the password the same way. The known_hosts check is never disabled.

**Long-running output:** `ssh_send` returns at the settle/timeout; if the footer says output is still arriving, call `ssh_read { "session": "s1", "waitMs": 2000 }` to poll for more. `ssh_read` blocks until *new* output arrives (footer `wait=idle`/`timeout`) or reports `wait=quiet` if nothing new came within `waitMs`.

## Security notes

This server hands an AI agent a real shell with **your** SSH identity. Read this section before wiring it into anything.

- **The agent can do whatever your keys can do.** Every host reachable from your `~/.ssh/config` and agent is reachable by the model. Use your MCP client's permission prompts (don't blanket-allow `ssh_send`), and consider a dedicated restricted key or user for agent-driven work.
- **Remote output is untrusted input to the model.** Screen content from a remote host flows back into the agent's context; a compromised or malicious host could try prompt injection through banners, MOTDs, or command output. Treat sessions to untrusted hosts accordingly.
- **known_hosts verification is left on.** The server does not add `StrictHostKeyChecking=no` or similar; you decide, per host, by answering the fingerprint prompt.
- **Argument injection is blocked** for `host`/`user`/`jump`: values starting with `-` are rejected and the destination is passed after a `--` separator, so a hostile hostname can't smuggle in ssh options like `ProxyCommand`. `extraArgs` remains a deliberate raw passthrough — treat it as you would a shell: options like `-oProxyCommand=…` execute **local** commands as the user running the server. If your MCP client supports per-tool argument review, scrutinize `extraArgs`.
- **`ssh_config_hosts` reads the file you point it at.** `configPath` accepts any path readable by the server's user (it only echoes config-shaped lines, but still). Point it at ssh configs only.
- **Credentials are never handled by this server**; `ssh`/ssh-agent own them. Passwords you type via `ssh_send` go straight to the PTY (not logged to stdout) — but they **do transit the MCP transport and may end up in client-side conversation logs**. Prefer key-based auth over typing passwords.
- Run it as your normal user so it inherits your `~/.ssh` and agent.

## Troubleshooting

- **`posix_spawnp failed` from node-pty on macOS:** the prebuilt `spawn-helper` lost its execute bit. Fix: `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`. `npm run build` is unaffected, but a fresh `npm install` may need this once.
- **`ssh: connect to host … Connection refused`:** faithfully reported from the real `ssh`; the destination isn't listening. Session exits with code 255.
- **`Connection timed out during banner exchange` on a ProxyJump chain:** OpenSSH's `ConnectTimeout` (default here: 30) also caps the destination's banner exchange, and that clock keeps running while you answer interactive prompts (host key, password) at the *jump* hop. Answer promptly, or raise it: `extraArgs: ["-o", "ConnectTimeout=120"]`. Note that `-o` options are not propagated to the jump hop itself — its host key is checked against your default known_hosts.
- **`channel 0: open failed: administratively prohibited` via a jump host:** the jump's sshd has `AllowTcpForwarding no` (common on hardened/minimal distros, e.g. Alpine's default). Enable it on the jump host; ProxyJump needs TCP forwarding there.
- **Output looks truncated:** increase `maxLines` on `ssh_send`/`ssh_read`, or poll with `ssh_read`. The emulator keeps 5000 lines of scrollback per session.
- **Session limit reached:** at most 32 concurrent sessions; exited ones are evicted automatically, live ones must be `ssh_disconnect`ed first.

## Development

```bash
npm run build   # tsc → dist/
npm test        # vitest: unit tests + live PTY integration tests
```

```
src/
  index.ts       entry point; stdio transport + graceful shutdown
  server.ts      MCP server + tool definitions
  manager.ts     session registry + ssh argv builder
  session.ts     PTY + headless xterm; idle-wait + screen rendering
  keys.ts        key-token → byte-sequence translation
  sshConfig.ts   best-effort ~/.ssh/config host lister (discovery only)
test/            vitest tests (keys, argv builder, ssh_config, live PTY sessions)
Dockerfile       optional container packaging (see the Docker section)
```

Contributions welcome — please run `npm test` before opening a PR.

## License

[MIT](LICENSE)
