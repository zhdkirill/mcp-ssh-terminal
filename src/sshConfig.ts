import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { globSync } from "node:fs";

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export interface HostEntry {
  /** The Host pattern(s) on the entry line, e.g. "prod-web" or "*.internal". */
  patterns: string[];
  /** Resolved HostName if the entry sets one. */
  hostName?: string;
  /** Resolved User if the entry sets one. */
  user?: string;
  /** Resolved Port if the entry sets one. */
  port?: string;
  /** ProxyJump target if the entry sets one. */
  proxyJump?: string;
  /** File this entry was found in. */
  source: string;
}

/**
 * Best-effort parser for ~/.ssh/config, following `Include` directives. This
 * is only for discoverability (listing candidate host aliases) — actual
 * connection semantics are always delegated to the real ssh client, which is
 * the authority on config resolution, Match blocks, tokens, etc.
 */
export function listConfigHosts(configPath?: string): HostEntry[] {
  const start = configPath ? expandHome(configPath) : join(homedir(), ".ssh", "config");
  const entries: HostEntry[] = [];
  const seen = new Set<string>();

  const parseFile = (path: string) => {
    const abs = resolve(path);
    if (seen.has(abs)) return;
    seen.add(abs);
    if (!existsSync(abs)) return;

    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      return;
    }

    let current: HostEntry | null = null;
    const flush = () => {
      if (current) entries.push(current);
      current = null;
    };

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;

      const eq = line.replace(/^(\S+)\s*=\s*/, "$1 ");
      const spaceIdx = eq.search(/\s/);
      if (spaceIdx === -1) continue;
      const keyword = eq.slice(0, spaceIdx).toLowerCase();
      const value = eq.slice(spaceIdx + 1).trim();

      if (keyword === "host") {
        flush();
        current = { patterns: value.split(/\s+/), source: abs };
      } else if (keyword === "match") {
        // A Match block ends the current Host entry. We don't model Match
        // conditions (ssh itself is the authority) — but without this, the
        // block's directives would be misattributed to the previous Host.
        flush();
      } else if (keyword === "include") {
        // Includes may reference multiple space-separated glob patterns.
        for (const token of value.split(/\s+/)) {
          const target = expandHome(token);
          const globbed = isAbsolute(target) ? target : join(dirname(abs), target);
          try {
            for (const f of globSync(globbed)) parseFile(f);
          } catch {
            /* ignore unmatched includes */
          }
        }
      } else if (current) {
        if (keyword === "hostname") current.hostName = value;
        else if (keyword === "user") current.user = value;
        else if (keyword === "port") current.port = value;
        else if (keyword === "proxyjump") current.proxyJump = value;
      }
    }
    flush();
  };

  parseFile(start);
  // Exclude pure-wildcard catch-all entries from the listing — they're not
  // connectable destinations, just default blocks.
  return entries.filter((e) => e.patterns.some((p) => p !== "*" && !p.startsWith("!")));
}
