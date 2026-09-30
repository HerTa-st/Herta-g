import { describe, expect, it } from "vitest";
import { commandPhase, opPhase } from "./op-phase.js";

describe("opPhase", () => {
  it("reads by the verb: looking, changing, checking", () => {
    expect(opPhase("Reading", "a.ts")).toBe("explore");
    expect(opPhase("Searching", '"x"')).toBe("explore");
    expect(opPhase("Inspecting", "")).toBe("explore");
    expect(opPhase("Digesting", "report.pdf")).toBe("explore");
    expect(opPhase("Writing", "a.ts")).toBe("modify");
    expect(opPhase("Saving memory", "repo_fact")).toBe("modify");
    expect(opPhase("Stopping", "bg-1")).toBe("verify");
    // A legacy row, and any verb this renderer predates.
    expect(opPhase("Planning", "2/3")).toBe("explore");
    expect(opPhase("Pondering", "x")).toBe("explore");
  });

  it("a command's phase comes from the command", () => {
    expect(opPhase("Running", "npm test")).toBe("verify");
    expect(opPhase("Running", "ls -la")).toBe("explore");
    expect(opPhase("Running", "mkdir -p out")).toBe("modify");
  });
});

describe("commandPhase", () => {
  it.each([
    ["ls -la src", "explore"],
    ["cat package.json", "explore"],
    ['grep -rn "cursor" src | head -20', "explore"],
    ["git status", "explore"],
    ["git log --oneline -5", "explore"],
    ["git diff HEAD~1", "explore"],
    ["sed -n 1,40p src/a.ts", "explore"],
    ["find . -name '*.ts'", "explore"],
    ["node -v", "explore"],
    ["npm ls react", "explore"],
    ["ls 2>&1", "explore"],
    ["cat x > /dev/null", "explore"],
  ] as const)("%s → looking", (line, phase) => {
    expect(commandPhase(line)).toBe(phase);
  });

  it.each([
    ["mkdir -p src/utils", "modify"],
    ["rm -rf build", "modify"],
    ["mv a.ts b.ts", "modify"],
    ["cat > src/a.ts <<'EOF'", "modify"],
    ["echo hi >> notes.md", "modify"],
    ["sed -i 's/a/b/' x.ts", "modify"],
    ["git add -A && git commit -m fix", "modify"],
    ["git checkout -b feature", "modify"],
    ["npm install lodash", "modify"],
    ["pnpm add -D vitest", "modify"],
    ["pip install requests", "modify"],
    ["curl -o x.tgz https://example.com/x", "modify"],
  ] as const)("%s → changing", (line, phase) => {
    expect(commandPhase(line)).toBe(phase);
  });

  it.each([
    ["npm test", "verify"],
    ["pnpm run build", "verify"],
    ["npx vitest run", "verify"],
    ["node --test test/", "verify"],
    ["python3 main.py", "verify"],
    ["pytest -q", "verify"],
    ["cargo test", "verify"],
    ["go test ./...", "verify"],
    ["make", "verify"],
    ["./run.sh", "verify"],
    // The strongest part of a chain wins: checking over changing over looking.
    ["cd packages/core && npm test", "verify"],
    ["npm install && npm test", "verify"],
    ["FORCE_COLOR=0 npm test", "verify"],
    ["C:\\tools\\node.exe script.js", "verify"],
  ] as const)("%s → checking", (line, phase) => {
    expect(commandPhase(line)).toBe(phase);
  });

  it("an empty line is looking (nothing is being done)", () => {
    expect(commandPhase("")).toBe("explore");
  });
});
