# @herta/dsh-backend

Runs a 板砖 brief on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
instead of Herta's in-process coding agent.

This package implements `BackendRuntime` from `@herta/core`, so it is a drop-in
replacement for `CodingAgentRuntime`. It is the **path-3** integration: Herta
stays the host and the speaker, DSH becomes the thing that holds the tools.

## Why the seam is at the runtime, not the provider

Herta also has a `backendProvider` seam. Swapping only that is not enough:
Herta would keep its own tool set *and* DSH would bring its own, so every write
would happen twice and the two would disagree about the workspace. The whole
backend runtime is replaced, exactly as the CLI already does:

```ts
new DshSdkRuntime({
  launch: resolveDshLaunch({ cwd, binPath, dshHome, personaPrefix, apiKey }),
  createHarness: createSdkHarness,
});
```

`createBackendStack` still decides *which* runtime the app gets; this package
only supplies one.

## Deployment: the install must be split across two trees

**This is not optional.** Installing `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-sdk-client` into the same `node_modules` tree produces a
harness that starts, accepts a prompt, and then dies on the first tool call with
`Cannot read properties of undefined (reading 'prepare')`.

The cause is two incompatible release lines sharing one flat tree:

| Package | Line A (`0.0.1-rc.x`) | Line B (`0.1.5-rc.x`) |
| --- | --- | --- |
| `dsh-tools` | `0.0.1-rc.1` — publishes `TOOL_REGISTRY_SCHEDULER` | `0.1.5-rc.2` — publishes `TOOL_RUNTIME_SCHEDULER` |
| `dsh-agent` | `0.0.1-rc.5` | `0.1.5-rc.2` |
| `dsh-scope`, `dsh-session`, `dsh-invariants`, `dsh-llm`, … | `0.0.1-rc.5` | (nested under the SDK profile) |

`dsh-sdk-client@0.0.1-rc.1` declares five `peerDependencies` on line A with no
`peerDependenciesMeta`, so npm/pnpm hoist line A to the top of the tree — where
it shadows the line-B copies that the `sdk-minimal` profile needs. The agent
loop then reads `ctx.tools[TOOL_RUNTIME_SCHEDULER]`, gets `undefined` from the
hoisted line-A module, and dereferences it.

Nothing repairs this from inside one tree. Pinning the offending packages was
tried and does not work; `dsh --patch` is merge-only and cannot inject the
missing plugin rows. **Install the CLI and the SDK client into separate
directories and let Herta point at each explicitly.**

```
<cli-tree>/node_modules/@deepseek-ai/dsh/lib/bin.js      # spawned as a child process
<sdk-tree>/node_modules/@deepseek-ai/dsh-sdk-client/     # imported in-process
```

Set `DSH_BIN` (or pass `binPath`) to the CLI's `lib/bin.js`. The SDK client is
`peerDependenciesMeta.optional` here, so the package builds and tests without it;
`createSdkHarness` imports it lazily on first use.

### Herta owns its own DSH home

`DSH_HOME` must not point inside either install tree. The harness resolves
profile plugins by walking up from the home, so a home inside a tree that also
holds a flat SDK install reintroduces the line-A copy above.

It defaults to `<home>/.herta/dsh-home` — machine-level, beside the user's other
`.herta` state, *not* per-workspace: a profile is machine configuration, and a
per-project home would make the operator recreate it in every project they touch.

Create the profile once, from the CLI tree:

```
dsh --profile <name> --from-default-profile sdk-minimal --dump-config
```

`--from-default-profile` creates it; `--dump-config` is what writes it to disk.

## What reaches Herta

`projectRun` projects the harness's event stream onto `AgentExecutionReport`.
Two rules drive it:

- **The model's prose is discarded.** `AgentExecutionReport` deliberately has no
  summary field, so nothing the harness says can end up in Herta's mouth.
  Evidence is built from `tool/call` and `tool/result` pairs instead.
- **Uncertainty is reported, not hidden.** Because `sdk-minimal` exposes only
  `pwsh`, every file change is inferred from shell text rather than a structured
  write result, and that inference is always listed in `residualRisks`. A tool
  call with no matching result becomes a risk rather than evidence.
- **Paths come back workspace-relative.** Models write absolute paths often
  enough that the raw transcription would put the machine's directory layout in
  a field Herta compares against git's repo-relative paths and narrates to the
  user. A path inside the launch workspace is rewritten relative and
  forward-slashed; a path outside it is left absolute on purpose, because
  `../../..` would hide where the file actually landed.

`status` comes from `turn/end.reason.kind`: `completed` → `completed`, absent →
`partial`, anything else → `failed`. `interrupted` is never produced by a turn —
the wire has no cancel — only by a local abort of the *wait*.

## The operation rows come from the bus, not the report

`AgentExecutionReport` decides only the terminal marker. Every `→ 差分协处理器`
operation row the user sees is projected from an **`AgentEvent` on the session
bus**, which the in-process `CodingAgentRuntime` publishes itself and an
out-of-process harness cannot — its work arrives as JSON-RPC notifications.

`DshSdkRuntime` therefore takes the session `bus` and republishes each call
through `DshBusTranslator`: `tool/call` → `tool.call.started`, `tool/result` →
`tool.call.finished`. Mount it without a bus and the bridge drains an empty bus
for the whole dispatch, so `projectedAny` stays false, and a turn that ran eight
commands renders as `差分协处理器 无产出` — the harness works and the record
says it did nothing. `createBackendStack` hands the bus over; the only way to
get this wrong is to construct a `DshSdkRuntime` by hand.

Two details of the translation are load-bearing:

- **`pwsh` is published as `bash`.** Its single argument is `{command}` and its
  model-facing output is plain text, which is the minimal contract's shell
  (ADR 0040) in everything but name. Herta's `workflowLabel` has no case for
  `pwsh` and returns `null` for it, so an unmapped name is dropped before it
  reaches the record — and mapping it also gets the `cd <workspace> &&` prefix
  stripped and the workspace path relativised by the existing summariser.
- **A result carries a receipt, not a `RunCommandData`.** The projection's
  success branch wants a structured exit code that DSH's
  `Invoke-Expression`-wrapped tool-result text does not contain; inventing
  `exitCode: 0` would paint a failed command green. Successes publish a bare
  `{ok: true, summary}`, which the projection drops on purpose (the
  `tool.call.started` row is the beat), while failures publish
  `{ok: false, error: {code: "tool_error", …}}` and do surface as `系统` rows.

`tool/result` names only a `callId`, so the translator remembers the tool name
from the `tool/call` that opened it and drops the entry when the result lands.
The ledger is per dispatch: a reused id in a later turn must not inherit the
previous turn's tool.

## Aborts are local

`AbortSignal` ends this call's wait and returns `interrupted`; it does not stop
the harness. The wire protocol has no cancel, so the orphaned turn keeps running
and keeps holding the serial queue until it settles on its own. The returned
report says so in `residualRisks` rather than implying the harness stopped.

Briefs are serialized because the harness is single-agent: two overlapping
prompts would interleave on one inbox. Each brief gets a fresh session id, since
DSH persists sessions by id and rejects reuse.

## Persona injection

`launch.personaPrefix` is forwarded as `DSH_SYSTEM_PROMPT`, which the
`sdk-minimal` profile wires to `system-prompt.personaPrefix`. This is the
harness's only zero-code persona seam — Herta's voice stays a launch parameter
instead of a patched profile file.

## Using it from the CLI

The CLI mounts this runtime when `HERTA_BACKEND=dsh`:

```
HERTA_BACKEND=dsh HERTA_DSH_BIN=<cli-tree>/node_modules/@deepseek-ai/dsh/lib/bin.js herta
```

| Variable | Meaning |
| --- | --- |
| `HERTA_BACKEND` | `dsh` mounts this runtime; anything else keeps the in-process agent |
| `HERTA_DSH_BIN` | The CLI tree's `lib/bin.js`. `DSH_BIN` is also accepted as a fallback |
| `HERTA_DSH_SDK` | An absolute path to the SDK client's entry. Required by the packaged GUI — see below. `DSH_SDK` is also accepted as a fallback |
| `HERTA_DSH_HOME` | Overrides the DSH home (default `<home>/.herta/dsh-home`) |
| `HERTA_DSH_PROFILE` | Profile name (default `sdk-minimal`) |
| `HERTA_DSH_PERSONA` | The harness's `personaPrefix` — how Herta's voice reaches DSH |
| `HERTA_DSH_MODEL` | Model id (default `deepseek-v4-flash`) |

`HERTA_BACKEND_MODEL` is deliberately *not* forwarded: it names a Herta model
directory (`deepseek-flash`), which the harness does not provide under that name.

`DEEPSEEK_API_KEY` is read directly and passed to the child through its
environment — it is never written to a file or a profile.

### Lifecycle

`setupDshBackend` resolves the launch eagerly and warns once — naming the remedy —
if the CLI tree is unusable or if an explicitly named SDK path is missing, rather
than failing mid-session: a mount that cannot start disables the backend instead
of silently falling back to a different one.

One child process per workspace, memoized across `makeRuntimeFactory` calls, so
rebuilding the backend stack does not fork a second harness. The child's
`sandbox-policy.workspaceRoot` is its own `cwd`, so `/workspace set` closes the
old runtime and starts a new one. `close()` is called on the way out of the REPL
(in a `finally`) because the `BackendRuntime` seam has no `close()` of its own —
without the host reaping it, every CLI exit would leak a subprocess.

## Using it from the GUI

### Windows 可选附属包

GUI 安装器可以把 DSH 作为可选的 NSIS 组件提供。请准备一个附属包目录，
并保持两棵互不兼容的依赖树彼此分离：

```
<payload>/cli/node_modules/@deepseek-ai/dsh/lib/bin.js
<payload>/sdk/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js
```

运行 GUI Windows 打包命令前设置 `HERTA_DSH_PACKAGE_DIR=<payload>`。
安装器会将它放到 `resources/dsh-backend`；未设置该变量时，安装器会省略这个
组件。打包后的 GUI 在 `HERTA_BACKEND=dsh` 时会自动发现这些路径；如果显式
设置了 `HERTA_DSH_BIN` 或 `HERTA_DSH_SDK`，显式路径优先。

The desktop app mounts the same runtime behind the same `HERTA_BACKEND=dsh` gate,
but three things differ from the CLI — two of which are hard requirements.

**The SDK must be named by absolute path.** The packaged app is bundled: main and
preload inline their whole dependency graph and the installer ships **no
`node_modules`** (`electron.vite.config.ts`). This package is bundled into
`out/main/index.js`, so a bare `import("@deepseek-ai/dsh-sdk-client")` has
nowhere to resolve from at runtime, and because the specifier is a variable,
Rollup cannot warn about it either — it fails on the first dispatch, not at build
time. `HERTA_DSH_SDK` therefore names the SDK entry directly:

```
HERTA_BACKEND=dsh
HERTA_DSH_BIN=<cli-tree>/node_modules/@deepseek-ai/dsh/lib/bin.js
HERTA_DSH_SDK=<sdk-tree>/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js
```

An absolute path is turned into a `file://` URL and imported as-is, which also
satisfies the split-tree rule above for free: the SDK's own five peer
dependencies resolve inside *its* install tree rather than the host's.

**Electron's interpreter needs re-pointing.** The harness is always started
through `process.execPath`. In a Node host that *is* `node`, but in an Electron
main process it is `electron.exe`, and Electron does not run a script argument
the way Node does — it treats it as an app path and brings up a **second GUI
process**. That process never answers the JSON-RPC handshake, so the first brief
hangs with no error at all: no rejection, no timeout, nothing to read in the log.
`resolveDshLaunch` therefore adds `ELECTRON_RUN_AS_NODE=1` when
`process.versions.electron` is set (overridable through the `electronMain` input,
which exists so the branch stays testable). The flag makes `electron.exe` behave
as a plain Node interpreter, and the child is then a lone `node` process whose
own children are just the tool processes it spawns — verified inside a real
Electron main process, where the same launch *without* the flag immediately
produces `gpu-process` and `utility` children.
A Node host is left untouched, because Node ignores the variable; setting it
unconditionally would leak into any grandchild that *is* an Electron app.

**Each session reaps its own child.** The CLI has one `repl()` and can close in a
`finally`; a desktop session has no such single return point — sessions are
closed by a workspace switch, a window close, or quit. So the handle is held by
the session and released from `SessionImpl.close()`. One harness per session, not
per process.

Set these in the environment Herta is launched from; the app-server reads them
once, at session create. Leaving `HERTA_BACKEND` unset keeps the in-process
backend, which is still the shipped default.

`pnpm --filter @herta/gui dev` runs the app from source and is the quickest way
to try the mount. Note that a passing `electron-vite build` does **not** mean the
app can be started: building only needs the bundler, while running needs
Electron's own postinstall download, so `node_modules/electron/dist/electron.exe`
may be absent in a checkout that never completed an install. If it is, run
`node node_modules/electron/install.js` in `packages/gui` first.

## Approval prompts do not cover the harness

Mounting this runtime **bypasses Herta's `RulePermissionEngine`**. The harness
holds the tools, so its own sandbox policy decides what runs; Herta's approval
prompt never sees those commands and cannot refuse them. `sdk-minimal` ships
`sandbox-policy(mode: danger-full-access)`. Treat enabling `HERTA_BACKEND=dsh`
as granting the model unrestricted shell access to the workspace, and confirm the
harness's own policy before relying on the default.

There is no per-turn approval to fall back on either: once mounted, the harness
runs the whole brief inside its own sandbox, and Herta only sees the resulting
`AgentExecutionReport`. This applies to GUI sessions exactly as it does to the
CLI.

## Tests

`project-report.test.ts` replays a **real captured turn** (17 events, in
`__fixtures__/real-turn.ts`) rather than a hand-written approximation, because
the wire shapes are not what the SDK's README documents: `data.reason` is a
string on `step/end` and an object on `turn/end`, `tool/call.arguments` is a JSON
string, and `request/header.tools` carries fields no published type declares.

`bus-events.test.ts` covers the translation in isolation, and the noop-marker
regression is covered end to end from the app-server side: the session test
`projects a mounted harness's commands onto the record instead of the noop-marker`
mounts a **real** `DshSdkRuntime` over a fake `DshHarnessPort`, drives one
`tool/call` + `tool/result` + `turn/end`, and asserts the record carries a
`Running …` operation row and a `done-marker` rather than a `noop-marker`.
Substituting a fake runtime would not catch the bug it exists for — a mount that
holds a bus but never publishes to it — because that failure lives between the
runtime's own `onNotification` and the bus.
