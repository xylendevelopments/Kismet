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
// @namespace    https://github.com/xylendevelopments/Kismet
// @version      ${pkg.version}
// @updateURL    https://raw.githubusercontent.com/xylendevelopments/Kismet/main/release/kismet.user.js
// @downloadURL  https://raw.githubusercontent.com/xylendevelopments/Kismet/main/release/kismet.user.js
// @description  Kismet — its own cursor-and-click autoplay for webosu! (osu!standard in the browser). Drives the site's own input listeners; never uses the site's built-in Autoplay mod. Optional reproducible timing humanization.
// @author       tussle1
// @match        *://webosu-online.netlify.app/*
// @match        *://webosu.online/*
// @match        *://*.webosu.online/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @include      http://localhost:*/*
// @include      http://127.0.0.1:*/*
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

// --- bootstrap userscript (installs even if the big file will not) -------
// A 370 KB userscript is a lot to paste into Tampermonkey's editor, and a
// truncated paste fails silently in the browser. This artifact is ~40 lines: it
// logs that it ran, then loads the engine from a CDN. It doubles as the answer
// to "is Tampermonkey running anything on this page at all?".
const ENGINE_URLS = [
  "https://cdn.jsdelivr.net/gh/xylendevelopments/Kismet@main/release/kismet.user.js",
  "https://raw.githubusercontent.com/xylendevelopments/Kismet/main/release/kismet.user.js",
];

const BOOTSTRAP_HEADER = `// ==UserScript==
// @name         Kismet (bootstrap)
// @namespace    https://github.com/xylendevelopments/Kismet
// @version      ${pkg.version}
// @description  Loads the Kismet engine from a CDN. Use this if installing the full userscript fails: it is tiny, it logs to the console, and it works around a truncated paste.
// @author       tussle1
// @match        *://webosu-online.netlify.app/*
// @match        *://webosu.online/*
// @match        *://*.webosu.online/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @include      http://localhost:*/*
// @include      http://127.0.0.1:*/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==
`;

const bootstrap = `${BOOTSTRAP_HEADER}
(() => {
  "use strict";
  if (window.Kismet) {
    console.info("[Kismet] engine already running");
    return;
  }
  const sources = ${JSON.stringify(ENGINE_URLS, null, 2)}.map((url) => url + "?v=${pkg.version}");
  console.info("[Kismet] bootstrap running on " + location.href);

  const fail = () => console.error("[Kismet] could not load the engine from any source");

  const load = (index) => {
    if (index >= sources.length) return fail();
    const script = document.createElement("script");
    script.src = sources[index];
    script.async = false;
    script.onload = () => console.info("[Kismet] engine loaded from " + sources[index].split("?")[0]);
    script.onerror = () => {
      console.warn("[Kismet] failed: " + sources[index].split("?")[0]);
      load(index + 1);
    };
    (document.head || document.documentElement).appendChild(script);
  };

  load(0);
})();
`;

await writeFile(resolve(root, "dist/kismet-bootstrap.user.js"), bootstrap, "utf8");
await mkdir(resolve(root, "release"), { recursive: true });
await writeFile(resolve(root, "release/kismet-bootstrap.user.js"), bootstrap, "utf8");

// --- bookmarklet (no userscript manager required) -----------------------
// Points at the CDN copy of the engine, so the bookmark URL stays short enough
// for every browser to accept as a bookmark.
const loader =
  "javascript:(function(){if(window.Kismet){return console.info('[Kismet] already running');}" +
  "var urls=" + JSON.stringify(ENGINE_URLS) + ",i=0;" +
  "function next(){if(i>=urls.length){return alert('Could not load Kismet.');}" +
  "var s=document.createElement('script');s.src=urls[i++]+'?v=${pkg.version}';" +
  "s.onerror=next;s.onload=function(){};(document.head||document.documentElement).appendChild(s);}" +
  "next();})();";
await writeFile(
  resolve(root, "dist/bookmarklet-loader.txt"),
  loader.replace(/\$\{pkg\.version\}/g, pkg.version),
  "utf8",
);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log("");
console.log(`  dist/kismet.user.js        ${kb(Buffer.byteLength(userscript))}`);
console.log(`  dist/kismet.js             ${kb(Buffer.byteLength(code))}`);
console.log(`  dist/bookmarklet.txt        ${kb(Buffer.byteLength(bookmarklet))}`);
console.log(`  dist/bookmarklet-loader.txt ${kb(Buffer.byteLength(loader))}`);
console.log(`  dist/kismet-bootstrap.user.js ${kb(Buffer.byteLength(bootstrap))}`);

if (Buffer.byteLength(bookmarklet) > 60_000) {
  console.log("");
  console.log("  ⚠ The inline bookmarklet is large. Many browsers truncate bookmark URLs");
  console.log("    past ~64KB. Prefer the userscript, or dist/bookmarklet-loader.txt,");
  console.log("    which loads the engine from the CDN instead of inlining it.");
}

if (watch) {
  const ctx = await (
    await import("esbuild")
  ).context({ ...baseOptions, minify: true, write: false, banner: { js: BANNER } });
  await ctx.watch();
  console.log("\n  watching src/ …\n");
}
