import type {
  DshHarnessFactoryOptions,
  DshHarnessPort,
} from "./dsh-sdk-runtime.js";
import { DSH_SDK_MODULE } from "./resolve-launch.js";

/**
 * Module id of the harness SDK, resolved lazily at runtime.
 *
 * Held in a variable so TypeScript never tries to resolve it: the package is
 * published with `publishConfig.access: restricted` and its peer line
 * (`0.0.1-rc.x`) conflicts with the one the CLI bundle embeds, so it stays an
 * optional peer — Herta compiles and runs without it, and only needs it when a
 * session is actually configured to use the DSH backend.
 */
const SDK_MODULE = DSH_SDK_MODULE;

interface SdkHarnessConstructor {
  new (options: DshHarnessFactoryOptions): DshHarnessPort;
}

/**
 * Default `createHarness` for production. The error names the missing package
 * rather than surfacing a bare `ERR_MODULE_NOT_FOUND`, because the fix
 * (install the SDK alongside the CLI, in its own tree) is not obvious from the
 * resolution error.
 *
 * `moduleId` is the specifier to import — a bare id by default, or a file URL
 * when a bundled host had to name an absolute path (see `resolveDshSdk`).
 */
export async function createSdkHarness(
  options: DshHarnessFactoryOptions,
  moduleId: string = SDK_MODULE,
): Promise<DshHarnessPort> {
  let sdk: { DeepSeekHarness?: SdkHarnessConstructor };
  try {
    sdk = (await import(moduleId)) as {
      DeepSeekHarness?: SdkHarnessConstructor;
    };
  } catch (error) {
    throw new Error(
      `无法加载 ${moduleId}（DSH 后端需要它，且必须与 CLI 分树安装）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const Constructor = sdk.DeepSeekHarness;
  if (Constructor === undefined) {
    throw new Error(`${moduleId} 未导出 DeepSeekHarness`);
  }
  return new Constructor(options);
}
