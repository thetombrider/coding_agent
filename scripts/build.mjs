// Compiles src/ -> dist/ with babel (TypeScript + babel-preset-solid universal),
// so @opentui/solid JSX runs on Node. Mirrors scripts/solid-node-loader.mjs.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import ts from "@babel/preset-typescript";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const srcDir = join(root, "src");
const outDir = join(root, "dist");

const TSX_RE = /\.[cm]?tsx$/;
const TS_RE = /\.[cm]?tsx?$/;
const TEST_RE = /\.test\.[cm]?tsx?$/;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function build() {
  await rm(outDir, { recursive: true, force: true });

  for await (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    if (TEST_RE.test(file)) continue;

    if (TS_RE.test(file)) {
      const code = await readFile(file, "utf8");
      const presets = [];
      if (TSX_RE.test(file)) {
        presets.push([solid, { moduleName: "@opentui/solid", generate: "universal" }]);
      }
      presets.push([ts]);
      const out = await transformAsync(code, {
        filename: file,
        configFile: false,
        babelrc: false,
        presets,
      });
      const dest = join(outDir, rel.replace(TS_RE, ".js"));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, out?.code ?? code);
    } else {
      // Copy assets (e.g. tool description .txt files) verbatim.
      const dest = join(outDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await cp(file, dest);
    }
  }

  console.log("Built dist/ from src/");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
