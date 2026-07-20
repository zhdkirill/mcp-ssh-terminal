import { Session } from "./session.js";
import { expandHome } from "./sshConfig.js";

export interface ConnectSpec {
  /** Destination: an ssh_config Host alias, hostname, or user@hostname. */
  host: string;
  user?: string;
  port?: number;
  /** IdentityFile path (-i). ~ is expanded. */
  identityFile?: string;
  /** ProxyJump chain (-J), e.g. "bastion" or "userA@a,userB@b". */
  jump?: string;
  /** Raw command to run instead of an interactive login shell. */
  remoteCommand?: string;
  /** Extra raw ssh arguments appended verbatim. */
  extraArgs?: string[];
  /** Force PTY allocation on the remote side (-tt). Default true. */
  forceTty?: boolean;
  cols?: number;
  rows?: number;
}

export interface BuiltCommand {
  file: string;
  args: string[];
  label: string;
}

/** Reject values that would be parsed as ssh options (argument injection). */
function assertNotOptionLike(value: string | undefined, name: string): void {
  if (value !== undefined && value.startsWith("-")) {
    throw new Error(`\`${name}\` must not start with "-" (would be parsed as an ssh option): ${value}`);
  }
}

/**
 * Build the argv for the OpenSSH client from a connect spec. Everything the
 * ssh client natively understands — ~/.ssh/config, known_hosts, ssh-agent,
 * ProxyJump — is left to ssh; we only translate the explicit overrides.
 */
export function buildSshCommand(spec: ConnectSpec): BuiltCommand {
  assertNotOptionLike(spec.host, "host");
  assertNotOptionLike(spec.user, "user");
  assertNotOptionLike(spec.jump, "jump");
  if (spec.user && spec.host.includes("@")) {
    throw new Error(`\`user\` was given but \`host\` already contains "@": ${spec.host}`);
  }

  const args: string[] = [];

  // Disable the ssh escape character. We drive stdin programmatically, so the
  // interactive "~." disconnect sequence would otherwise be a footgun and
  // would stop arbitrary control bytes from passing through verbatim.
  args.push("-e", "none");

  if (spec.forceTty !== false) {
    args.push("-tt"); // force remote PTY even though stdin is already a tty
  }

  if (spec.port !== undefined) args.push("-p", String(spec.port));
  if (spec.identityFile) args.push("-i", expandHome(spec.identityFile));
  if (spec.jump) args.push("-J", spec.jump);
  if (spec.extraArgs) args.push(...spec.extraArgs);

  // Sessions are long-lived by design; keepalives stop NAT/conntrack from
  // silently dropping idle connections, and ConnectTimeout bounds a dead
  // host. OpenSSH uses the first occurrence of an -o option, so these come
  // after extraArgs and act as overridable defaults.
  // ConnectTimeout also caps the destination's banner exchange, and on a
  // ProxyJump chain that clock keeps running while interactive prompts at
  // the jump hop await answers — 30s gives an agent room to answer them.
  args.push(
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=30"
  );

  const destination = spec.user ? `${spec.user}@${spec.host}` : spec.host;
  // "--" ends option parsing so a hostile destination can't inject options
  // (e.g. host: "-oProxyCommand=...").
  args.push("--", destination);

  if (spec.remoteCommand) args.push(spec.remoteCommand);

  const label = spec.remoteCommand ? `${destination} :: ${spec.remoteCommand}` : destination;
  return { file: "ssh", args, label };
}

/** Cap on concurrent sessions; oldest exited ones are evicted to make room. */
const MAX_SESSIONS = 32;

/** In-memory registry of live sessions. */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private counter = 0;

  create(cmd: BuiltCommand, cols: number, rows: number): Session {
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestExited = [...this.sessions.values()]
        .filter((s) => s.exited)
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!oldestExited) {
        throw new Error(`Session limit (${MAX_SESSIONS}) reached and all are live; ssh_disconnect one first.`);
      }
      this.remove(oldestExited.id);
    }
    const id = `s${++this.counter}`;
    const session = new Session(id, {
      file: cmd.file,
      args: cmd.args,
      cols,
      rows,
      label: cmd.label,
    });
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  require(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) {
      const known = [...this.sessions.keys()].join(", ") || "none";
      throw new Error(`Unknown session "${id}". Active sessions: ${known}.`);
    }
    return s;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  remove(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close();
    // Escalate like closeAll: a child that ignores SIGHUP (e.g. a wedged
    // ProxyCommand) would otherwise leak past the registry.
    setTimeout(() => s.kill(), 250).unref?.();
    this.sessions.delete(id);
    return true;
  }

  /**
   * SIGHUP everything, escalating to SIGKILL after `escalateMs` for children
   * that ignore it. Callers that exit afterwards must wait past `escalateMs`.
   */
  closeAll(escalateMs = 250): void {
    for (const s of this.sessions.values()) s.close();
    setTimeout(() => {
      for (const s of this.sessions.values()) s.kill();
    }, escalateMs).unref?.();
  }
}
