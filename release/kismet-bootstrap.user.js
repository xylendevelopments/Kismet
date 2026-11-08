// ==UserScript==
// @name         Kismet (bootstrap)
// @namespace    https://github.com/xylendevelopments/Kismet
// @version      2.0.2
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

(() => {
  "use strict";
  if (window.Kismet) {
    console.info("[Kismet] engine already running");
    return;
  }
  const sources = [
  "https://cdn.jsdelivr.net/gh/xylendevelopments/Kismet@main/release/kismet.user.js",
  "https://raw.githubusercontent.com/xylendevelopments/Kismet/main/release/kismet.user.js"
].map((url) => url + "?v=2.0.2");
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
