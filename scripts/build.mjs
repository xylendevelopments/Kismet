#!/usr/bin/env node
/**
 * Build script.
 *
 * Produces three artifacts from the same bundle:
 *
 *   dist/kismet.user.js     userscript (Tampermonkey / Violentmonkey / Greasy Fork)
 *   dist/kismet.js          plain script, for a <script> tag or devtools paste
 *   dist/bookmarklet.txt    javascript: URI (see the size warning below)
 *
 * No runtime dependencies: the tool is one self-contained bundle.
 */

import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const watch = process.argv.includes("--watch");

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
// Embed the original cover artwork: the userscript remains a single file and
// does not depend on another host (or the game's own artwork URLs).
const cover = await readFile(resolve(root, "assets/trainer-cover.jpg"));
const coverData = `data:image/jpeg;base64,${cover.toString("base64")}`;

// Torus is commercially licensed, so it is not redistributed. Embed the OFL
// Comfortaa fallback instead, with all upstream language subsets and weights.
// Referencing Torus by family name at runtime still lets an installed or
// page-provided copy take priority. The fallback stays offline and self-contained.
const fontDir = resolve(root, "assets/fonts/comfortaa");
let fontCss = await readFile(resolve(fontDir, "wght.css"), "utf8");
fontCss = fontCss.replaceAll("'Comfortaa Variable'", "'Kismet Rounded'");
const fontPaths = [...fontCss.matchAll(/url\(\.\/files\/([^)]*)\)/g)].map((match) => match[1]);
if (fontPaths.length === 0) throw new Error("No Comfortaa font subsets found in the upstream CSS");
for (const name of fontPaths) {
  const bytes = await readFile(resolve(fontDir, "files", name));
  fontCss = fontCss.replace(`url(./files/${name})`, `url("data:font/woff2;base64,${bytes.toString("base64")}")`);
}
const fontLicense = await readFile(resolve(fontDir, "OFL.txt"), "utf8");

const USERSCRIPT_HEADER = `// ==UserScript==
// @name         Kismet
// @namespace    https://github.com/tussle1/Kismet
// @version      ${pkg.version}
// @updateURL    https://raw.githubusercontent.com/tussle1/Kismet/main/release/kismet.user.js
// @downloadURL  https://raw.githubusercontent.com/tussle1/Kismet/main/release/kismet.user.js
// @description  Kismet — its own cursor-and-click autoplay for webosu! (osu!standard in the browser). Drives the site's own input listeners; never uses the site's built-in Autoplay mod. Optional reproducible timing humanization.
// @author       tussle1
// @match        https://webosu-online.netlify.app/*
// @match        https://webosu.online/*
// @match        https://*.webosu.online/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT AND OFL-1.1
// ==/UserScript==
`;

// The userscript and plain script are each standalone redistributions of the
// OFL font, so include the complete copyright notice and license in both.
const BANNER = `/*! Kismet v${pkg.version} — its own cursor-and-click autoplay for webosu!. Never uses the site's built-in Autoplay mod. */\n/* Bundled fallback font: Comfortaa (SIL Open Font License 1.1)\n${fontLicense.replaceAll("*/", "* /")}\n*/`;

/** Shared esbuild options. */
const baseOptions = {
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  format: "iife",
  target: ["es2022", "chrome110", "firefox115", "safari16.4"],
  platform: "browser",
  legalComments: "none",
  logLevel: "info",
  tsconfig: resolve(root, "tsconfig.json"),
  define: {
    __KISMET_COVER__: JSON.stringify(coverData),
    __KISMET_FONT_CSS__: JSON.stringify(fontCss),
  },
};

await mkdir(resolve(root, "dist"), { recursive: true });

const minified = await build({
  ...baseOptions,
  minify: true,
  write: false,
  banner: { js: BANNER },
});

const code = minified.outputFiles[0].text;

// --- userscript ---------------------------------------------------------
// Wrap in an IIFE so the bundle's top-level scope can't collide with the page.
const userscript = `${USERSCRIPT_HEADER}\n(() => {\n"use strict";\n${code}\n})();\n`;
await writeFile(resolve(root, "dist/kismet.user.js"), userscript, "utf8");

// --- committed install artifact -----------------------------------------
// dist/ is gitignored, but a userscript needs a stable public URL to install
// and update from. release/kismet.user.js is that artifact: raw.githubusercontent.com
// serves it straight from the branch, and the header's @updateURL/@downloadURL
// point at it. Refreshing it is part of the build so the two cannot drift.
await mkdir(resolve(root, "release"), { recursive: true });
await writeFile(resolve(root, "release/kismet.user.js"), userscript, "utf8");

// --- plain script -------------------------------------------------------
await writeFile(resolve(root, "dist/kismet.js"), code, "utf8");

// --- bookmarklet --------------------------------------------------------
// Percent-encode conservatively: only characters that are unsafe in a URI.
// A bookmarklet of this size exceeds what some browsers accept in a bookmark
// URL, so the README documents the snippet-loader alternative as the
// recommended path.
const bookmarkletBody = encodeURIComponent(code)
  .replace(/%20/g, "+")
  .replace(/[!'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const bookmarklet = `javascript:(function(){try{var s=document.createElement('script');s.textContent=decodeURIComponent("${bookmarkletBody}");document.documentElement.appendChild(s);s.remove();}catch(e){alert('Kismet failed to start: '+e.message);}})();`;

await writeFile(resolve(root, "dist/bookmarklet.txt"), bookmarklet, "utf8");

// --- devtools snippet loader (the practical bookmarklet) ----------------
const loader = `javascript:(function(){var s=document.createElement('script');s.src='RAW_URL_HERE/dist/kismet.js';s.onload=function(){console.log('Kismet loaded');};s.onerror=function(){alert('Could not load kismet.js — check the URL and CORS.');};document.documentElement.appendChild(s);})();`;
await writeFile(resolve(root, "dist/bookmarklet-loader.txt"), loader, "utf8");

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log("");
console.log(`  dist/kismet.user.js        ${kb(Buffer.byteLength(userscript))}`);
console.log(`  dist/kismet.js             ${kb(Buffer.byteLength(code))}`);
console.log(`  dist/bookmarklet.txt        ${kb(Buffer.byteLength(bookmarklet))}`);
console.log(`  dist/bookmarklet-loader.txt ${kb(Buffer.byteLength(loader))}`);

if (Buffer.byteLength(bookmarklet) > 60_000) {
  console.log("");
  console.log("  ⚠ The inline bookmarklet is large. Many browsers truncate bookmark URLs");
  console.log("    past ~64KB. Prefer the userscript, or host dist/kismet.js and use");
  console.log("    dist/bookmarklet-loader.txt with RAW_URL_HERE replaced.");
}

if (watch) {
  const ctx = await (
    await import("esbuild")
  ).context({ ...baseOptions, minify: true, write: false, banner: { js: BANNER } });
  await ctx.watch();
  console.log("\n  watching src/ …\n");
}
