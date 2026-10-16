// electron-vite's `?nodeWorker` import (its own `electron-vite/node` types,
// which this project's node tsconfig does not load): the module bundled as a
// worker chunk, and a factory that starts it.
declare module "*?nodeWorker" {
  import type { Worker, WorkerOptions } from "node:worker_threads";
  export default function createWorker(options?: WorkerOptions): Worker;
}
