#!/usr/bin/env node
// cogsync CLI entrypoint.
// tsx の tsImport API で src/index.ts を直接ロードする（ビルドステップなし）。
import { tsImport } from "tsx/esm/api";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "..", "src", "index.ts");

await tsImport(pathToFileURL(entry).href, import.meta.url);
