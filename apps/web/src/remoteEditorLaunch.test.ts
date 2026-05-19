import { describe, expect, it } from "vitest";

import {
  editorSupportsRemoteSshLaunch,
  resolveRemoteSshLaunchUrl,
  shouldUseRemoteSshLaunch,
} from "./remoteEditorLaunch";

describe("editorSupportsRemoteSshLaunch", () => {
  it("returns true for VS Code-family editors", () => {
    expect(editorSupportsRemoteSshLaunch("cursor")).toBe(true);
    expect(editorSupportsRemoteSshLaunch("vscode")).toBe(true);
    expect(editorSupportsRemoteSshLaunch("vscode-insiders")).toBe(true);
    expect(editorSupportsRemoteSshLaunch("vscodium")).toBe(true);
  });

  it("returns false for unsupported editors", () => {
    expect(editorSupportsRemoteSshLaunch("zed")).toBe(false);
    expect(editorSupportsRemoteSshLaunch("idea")).toBe(false);
    expect(editorSupportsRemoteSshLaunch("file-manager")).toBe(false);
    expect(editorSupportsRemoteSshLaunch("trae")).toBe(false);
  });
});

describe("resolveRemoteSshLaunchUrl", () => {
  it("builds a cursor URL for an absolute cwd", () => {
    expect(
      resolveRemoteSshLaunchUrl({
        editor: "cursor",
        cwd: "/Users/foo/proj",
        sshHost: "mac-mini.tail-123.ts.net",
      }),
    ).toBe("cursor://vscode-remote/ssh-remote+mac-mini.tail-123.ts.net/Users/foo/proj");
  });

  it("uses the matching scheme per editor", () => {
    expect(resolveRemoteSshLaunchUrl({ editor: "vscode", cwd: "/x", sshHost: "h" })).toBe(
      "vscode://vscode-remote/ssh-remote+h/x",
    );
    expect(resolveRemoteSshLaunchUrl({ editor: "vscode-insiders", cwd: "/x", sshHost: "h" })).toBe(
      "vscode-insiders://vscode-remote/ssh-remote+h/x",
    );
    expect(resolveRemoteSshLaunchUrl({ editor: "vscodium", cwd: "/x", sshHost: "h" })).toBe(
      "vscodium://vscode-remote/ssh-remote+h/x",
    );
  });

  it("encodes special characters in the path but preserves slashes", () => {
    expect(
      resolveRemoteSshLaunchUrl({
        editor: "cursor",
        cwd: "/Users/foo/my project/with space",
        sshHost: "host",
      }),
    ).toBe("cursor://vscode-remote/ssh-remote+host/Users/foo/my%20project/with%20space");
  });

  it("prepends a leading slash if missing so the URL stays well-formed", () => {
    expect(resolveRemoteSshLaunchUrl({ editor: "cursor", cwd: "Users/foo", sshHost: "host" })).toBe(
      "cursor://vscode-remote/ssh-remote+host/Users/foo",
    );
  });

  it("supports user@host authority forms", () => {
    expect(
      resolveRemoteSshLaunchUrl({ editor: "cursor", cwd: "/x", sshHost: "matt@macmini" }),
    ).toBe("cursor://vscode-remote/ssh-remote+matt@macmini/x");
  });

  it("returns null for editors without a known remote-SSH scheme", () => {
    expect(resolveRemoteSshLaunchUrl({ editor: "zed", cwd: "/x", sshHost: "h" })).toBeNull();
    expect(
      resolveRemoteSshLaunchUrl({ editor: "file-manager", cwd: "/x", sshHost: "h" }),
    ).toBeNull();
  });

  it("returns null for blank or malformed SSH hosts", () => {
    expect(resolveRemoteSshLaunchUrl({ editor: "cursor", cwd: "/x", sshHost: "" })).toBeNull();
    expect(resolveRemoteSshLaunchUrl({ editor: "cursor", cwd: "/x", sshHost: "   " })).toBeNull();
    expect(
      resolveRemoteSshLaunchUrl({ editor: "cursor", cwd: "/x", sshHost: "bad host" }),
    ).toBeNull();
    expect(
      resolveRemoteSshLaunchUrl({ editor: "cursor", cwd: "/x", sshHost: "h/oops" }),
    ).toBeNull();
  });
});

describe("shouldUseRemoteSshLaunch", () => {
  it("is false for loopback hostnames", () => {
    expect(shouldUseRemoteSshLaunch("localhost")).toBe(false);
    expect(shouldUseRemoteSshLaunch("127.0.0.1")).toBe(false);
    expect(shouldUseRemoteSshLaunch("::1")).toBe(false);
    expect(shouldUseRemoteSshLaunch("[::1]")).toBe(false);
  });

  it("is true for any non-loopback hostname", () => {
    expect(shouldUseRemoteSshLaunch("mac-mini.tail-123.ts.net")).toBe(true);
    expect(shouldUseRemoteSshLaunch("192.168.1.10")).toBe(true);
    expect(shouldUseRemoteSshLaunch("example.com")).toBe(true);
  });

  it("returns false for an empty hostname", () => {
    expect(shouldUseRemoteSshLaunch("")).toBe(false);
  });
});
