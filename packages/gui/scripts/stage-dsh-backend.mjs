import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const resourcesDir = resolve(scriptDir, "../build");
const targetDir = join(resourcesDir, "dsh-backend");
const sourceDir = process.env.HERTA_DSH_PACKAGE_DIR;

await rm(targetDir, { recursive: true, force: true });

if (sourceDir === undefined || sourceDir.trim() === "") {
  process.stdout.write(
    "herta: DSH payload not configured; omitting optional installer component\n",
  );
  process.exit(0);
}

const source = resolve(sourceDir);
const required = [
  join(source, "cli", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  join(
    source,
    "sdk",
    "node_modules",
    "@deepseek-ai",
    "dsh-sdk-client",
    "lib",
    "index.js",
  ),
];
if (required.some((file) => !existsSync(file))) {
  throw new Error(
    "HERTA_DSH_PACKAGE_DIR must contain separate cli/ and sdk/ install trees for DSH",
  );
}
await mkdir(targetDir, { recursive: true });
await cp(source, targetDir, { recursive: true, errorOnExist: false });
await writeFile(
  join(targetDir, "payload.json"),
  `${JSON.stringify({ name: "herta-dsh-backend", source }, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`herta: staged optional DSH payload from ${source}\n`);
