import { describe, expect, it } from "vitest";
import { withoutWorkspaceCd, workspaceRelative } from "./workspace-path.js";

describe("workspaceRelative", () => {
  const WS = "C:\\Users\\me\\.herta\\workspaces\\abc";

  it("reads every spelling of a path inside the workspace as the record's relative one", () => {
    expect(
      workspaceRelative("C:\\Users\\me\\.herta\\workspaces\\abc\\fib.js", WS),
    ).toBe("fib.js");
    expect(
      workspaceRelative("C:/Users/me/.herta/workspaces/abc/src/a.ts", WS),
    ).toBe("src/a.ts");
    // The MSYS shell's spelling, and a different case, as Windows compares.
    expect(
      workspaceRelative("/c/Users/me/.herta/workspaces/abc/fib.js", WS),
    ).toBe("fib.js");
    expect(
      workspaceRelative("c:/users/ME/.herta/workspaces/ABC/x.md", WS),
    ).toBe("x.md");
    expect(workspaceRelative("/c/Users/me/.herta/workspaces/abc", WS)).toBe(
      ".",
    );
  });

  it("leaves a relative path, a path outside, and a sibling that shares a prefix as given", () => {
    expect(workspaceRelative("src/a.ts", WS)).toBe("src/a.ts");
    expect(workspaceRelative("D:/other/a.ts", WS)).toBe("D:/other/a.ts");
    expect(
      workspaceRelative("C:/Users/me/.herta/workspaces/abcd/a.ts", WS),
    ).toBe("C:/Users/me/.herta/workspaces/abcd/a.ts");
    expect(workspaceRelative("a.ts", null)).toBe("a.ts");
  });

  it("POSIX workspaces compare with case", () => {
    expect(workspaceRelative("/home/me/ws/a.ts", "/home/me/ws")).toBe("a.ts");
    expect(workspaceRelative("/home/me/WS/a.ts", "/home/me/ws")).toBe(
      "/home/me/WS/a.ts",
    );
  });
});

describe("withoutWorkspaceCd", () => {
  const WS = "C:\\Users\\me\\ws";

  it("drops a leading cd into the workspace, in any spelling, quoted or not", () => {
    expect(withoutWorkspaceCd("cd /c/Users/me/ws && node a.js", WS)).toBe(
      "node a.js",
    );
    expect(withoutWorkspaceCd('cd "C:\\Users\\me\\ws"; ls', WS)).toBe("ls");
  });

  it("keeps a cd anywhere else — it says where the command runs", () => {
    expect(withoutWorkspaceCd("cd /c/Users/me/ws/sub && ls", WS)).toBe(
      "cd /c/Users/me/ws/sub && ls",
    );
    expect(withoutWorkspaceCd("ls && cd /c/Users/me/ws", WS)).toBe(
      "ls && cd /c/Users/me/ws",
    );
    expect(withoutWorkspaceCd("cd /c/Users/me/ws && ls", null)).toBe(
      "cd /c/Users/me/ws && ls",
    );
  });
});
