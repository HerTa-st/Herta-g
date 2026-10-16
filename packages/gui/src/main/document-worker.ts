import { parentPort } from "node:worker_threads";
import { serveDocumentExtraction } from "@herta/app-server/document-worker";

/**
 * The document reader's thread (owner, 2026-10-16): PDF and Word extraction,
 * pictures included, off the main process. Bundled by electron-vite as its
 * own chunk (`./document-worker?nodeWorker` in index.ts) beside the main
 * bundle; pdfjs's chunks are shared with it.
 */
if (parentPort !== null) serveDocumentExtraction(parentPort);
