import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listConfigHosts, expandHome } from "../src/sshConfig.js";

let dir: string;
let cfg: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-ssh-cfg-"));
  cfg = join(dir, "config");
  mkdirSync(join(dir, "conf.d"), { recursive: true });
  writeFileSync(
    join(dir, "conf.d", "extra"),
    ["Host included-host", "  HostName inc.example.com", "  User incuser"].join("\n")
  );
  writeFileSync(
    cfg,
    [
      "# a comment",
      "Include conf.d/*",
      "",
      "Host web prod-web",
      "  HostName 10.0.0.1",
      "  User deploy",
      "  Port 2222",
      "",
      "Host through-jump",
      "  HostName 10.0.0.9",
      "  ProxyJump bastion",
      "",
      "Host *",
      "  ServerAliveInterval 30",
      "",
      "Host last-host",
      "  HostName last.example.com",
      "Match host something",
      "  HostName match-block.example.com",
    ].join("\n")
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("listConfigHosts", () => {
  it("parses host entries with hostname/user/port", () => {
    const hosts = listConfigHosts(cfg);
    const web = hosts.find((h) => h.patterns.includes("web"));
    expect(web).toBeDefined();
    expect(web!.patterns).toEqual(["web", "prod-web"]);
    expect(web!.hostName).toBe("10.0.0.1");
    expect(web!.user).toBe("deploy");
    expect(web!.port).toBe("2222");
  });

  it("captures ProxyJump", () => {
    const hosts = listConfigHosts(cfg);
    const jumped = hosts.find((h) => h.patterns.includes("through-jump"));
    expect(jumped!.proxyJump).toBe("bastion");
  });

  it("follows Include directives", () => {
    const hosts = listConfigHosts(cfg);
    const inc = hosts.find((h) => h.patterns.includes("included-host"));
    expect(inc).toBeDefined();
    expect(inc!.hostName).toBe("inc.example.com");
  });

  it("omits the pure-wildcard catch-all block", () => {
    const hosts = listConfigHosts(cfg);
    expect(hosts.some((h) => h.patterns.length === 1 && h.patterns[0] === "*")).toBe(false);
  });

  it("returns empty for a missing file", () => {
    expect(listConfigHosts(join(dir, "does-not-exist"))).toEqual([]);
  });

  it("does not attribute Match-block directives to the previous Host", () => {
    const hosts = listConfigHosts(cfg);
    const last = hosts.find((h) => h.patterns.includes("last-host"));
    expect(last!.hostName).toBe("last.example.com");
  });
});

describe("expandHome", () => {
  it("expands a leading ~", () => {
    expect(expandHome("~/x").endsWith("/x")).toBe(true);
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
});
