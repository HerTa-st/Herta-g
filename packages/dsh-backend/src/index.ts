/**
 * `@herta/dsh-backend` — drives DeepSeek Harness as Herta's 板砖 backend.
 *
 * The in-process `CodingAgentRuntime` assumes it owns the tool loop; DSH owns
 * its own, so this package implements the `BackendRuntime` seam instead and
 * projects the harness's event stream back onto `AgentExecutionReport`. Herta's
 * persona layer, the permission engine and the bridge contracts are untouched:
 * the swap happens at `BackendStack.runtimeFactory`.
 */
export {
  DshBusTranslator,
  hertaToolName,
  summarizeHarnessInput,
} from "./bus-events.js";
export {
  type DshHarnessFactory,
  type DshHarnessFactoryOptions,
  type DshHarnessPort,
  type DshLaunchOptions,
  DshSdkRuntime,
  type DshSdkRuntimeDeps,
  renderTaskText,
} from "./dsh-sdk-runtime.js";
export type {
  DshContentBlock,
  DshMessage,
  DshNotification,
  DshRunResult,
  DshSessionEvent,
  DshToolDeclaration,
  DshTurnReason,
  DshUsage,
} from "./events.js";
export {
  DSH_BACKEND_ENV,
  DSH_BACKEND_VALUE,
  DSH_KNOBS,
  type DshBackendHandle,
  type DshBackendSetupInput,
  setupDshBackend,
} from "./mount.js";
export {
  changedFilesFromReceipts,
  collectToolReceipts,
  declaredToolNames,
  type ProjectionInput,
  parseToolCallCommand,
  projectRun,
  statusFromTurnReason,
  type ToolReceipt,
  type ToolReceipts,
  turnReasonOf,
} from "./project-report.js";
export {
  DEFAULT_DSH_PROFILE,
  DSH_API_KEY_ENV,
  DSH_BIN_ENV,
  DSH_SDK_ENV,
  DSH_SDK_MODULE,
  type ResolveDshLaunchInput,
  type ResolvedDshSdk,
  resolveDshBinPath,
  resolveDshLaunch,
  resolveDshSdk,
} from "./resolve-launch.js";
export { createSdkHarness } from "./sdk-harness.js";
