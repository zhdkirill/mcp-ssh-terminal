import { describe, it, expect } from "vitest";
import { buildSshCommand } from "../src/manager.js";

describe("buildSshCommand", () => {
  it("terminates option parsing with -- before the destination", () => {
    const { args } = buildSshCommand({ host: "router" });
    const sep = args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(args[sep + 1]).toBe("router");
  });

  it("rejects option-like host/user/jump values (argument injection)", () => {
    expect(() => buildSshCommand({ host: "-oProxyCommand=evil" })).toThrow(/ssh option/);
    expect(() => buildSshCommand({ host: "h", user: "-l" })).toThrow(/ssh option/);
    expect(() => buildSshCommand({ host: "h", jump: "-J evil" })).toThrow(/ssh option/);
  });

  it("rejects user combined with user@host instead of ignoring it", () => {
    expect(() => buildSshCommand({ host: "admin@router", user: "other" })).toThrow(/already contains "@"/);
  });

  it("prepends user to the destination", () => {
    const { args } = buildSshCommand({ host: "router", user: "admin" });
    expect(args[args.length - 1]).toBe("admin@router");
  });

  it("adds overridable keepalive/timeout defaults after extraArgs", () => {
    const { args } = buildSshCommand({ host: "h", extraArgs: ["-o", "ServerAliveInterval=5"] });
    const first = args.indexOf("ServerAliveInterval=5");
    const def = args.indexOf("ServerAliveInterval=30");
    // OpenSSH uses the first -o occurrence, so the caller's value must come first.
    expect(first).toBeGreaterThan(-1);
    expect(def).toBeGreaterThan(first);
    expect(args).toContain("ConnectTimeout=30");
    expect(args).toContain("ServerAliveCountMax=3");
  });

  it("places the remote command after the destination", () => {
    const { args } = buildSshCommand({ host: "router", remoteCommand: "/system identity print" });
    expect(args[args.length - 1]).toBe("/system identity print");
    expect(args[args.length - 2]).toBe("router");
  });
});
