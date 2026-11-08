import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The committed artifact is what people actually install, so its metadata — not
 * the template that generates it — is what gets validated here.
 *
 * This exists because a localhost @match with a port wildcard once shipped: a
 * port is not legal in a match pattern, and Tampermonkey reported the whole
 * script as supporting no websites at all, which made it impossible to install.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const artifact = resolve(root, "release", "kismet.user.js");

/**
 * The Chrome match-pattern grammar, which is what @match accepts:
 *
 *     <scheme>://<host><path>
 *
 * `<scheme>` is `http`, `https`, `file`, `ftp` or `*`; the host is `*`, a
 * hostname, or `*.` followed by a hostname; the path starts with `/` and may
 * contain `*`. Ports are not part of the grammar — a match pattern matches every
 * port — so a `:` in the host makes the pattern invalid.
 */
const MATCH_PATTERN = /^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(\/\S*)$/i;

function headerLines(text: string): string[] {
  const lines = text.split("\n");
  assert.equal(lines[0], "// ==UserScript==", "the file must begin with the userscript header");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "// ==/UserScript==");
  assert.ok(end > 0, "the userscript header must be terminated");
  return lines.slice(1, end);
}

function directive(lines: string[], name: string): string[] {
  const prefix = `// @${name}`;
  const values: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    if (rest.length > 0 && rest[0] !== " ") continue; // @matchfoo is not @match
    values.push(rest.trim());
  }
  return values;
}

describe("release/kismet.user.js", () => {
  let text: string;
  let lines: string[];

  it("loads", async () => {
    text = await readFile(artifact, "utf8");
    lines = headerLines(text);
    assert.ok(lines.length > 5, "the header should not be empty");
  });

  it("names the script Kismet", async () => {
    if (!text) text = await readFile(artifact, "utf8");
    if (!lines) lines = headerLines(text);
    assert.deepEqual(directive(lines, "name"), ["Kismet"]);
    assert.deepEqual(directive(lines, "grant"), ["none"], "the script needs no privileged APIs");
  });

  it("has at least one @match, and every @match is a legal pattern", async () => {
    if (!text) text = await readFile(artifact, "utf8");
    if (!lines) lines = headerLines(text);
    const matches = directive(lines, "match");
    assert.ok(matches.length > 0, "a userscript with no @match supports no websites");

    for (const pattern of matches) {
      assert.match(pattern, MATCH_PATTERN, `invalid @match: ${pattern}`);
      const host = pattern.split("://")[1]?.split("/")[0] ?? "";
      assert.ok(!host.includes(":"), `@match cannot carry a port: ${pattern} (use @include)`);
    }
  });

  it("matches the deployed site", async () => {
    if (!text) text = await readFile(artifact, "utf8");
    if (!lines) lines = headerLines(text);
    const matches = directive(lines, "match");
    assert.ok(
      matches.some((pattern) => /^(\*|https?):\/\/webosu-online\.netlify\.app\/\*$/.test(pattern)),
      `no @match covers webosu-online.netlify.app: ${JSON.stringify(matches)}`,
    );
  });

  it("uses @include for the port wildcards a dev server needs", async () => {
    if (!text) text = await readFile(artifact, "utf8");
    if (!lines) lines = headerLines(text);
    const includes = directive(lines, "include");
    assert.ok(
      includes.some((pattern) => pattern.includes("localhost")),
      `expected a localhost @include: ${JSON.stringify(includes)}`,
    );
  });

  it("reports the same version as the package", async () => {
    if (!text) text = await readFile(artifact, "utf8");
    if (!lines) lines = headerLines(text);
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    assert.deepEqual(directive(lines, "version"), [pkg.version]);
  });

  it("is a userscript wrapper around the bundle, not the bare bundle", async () => {
    if (!text) text = await readFile(artifact, "utf8");
    if (!lines) lines = headerLines(text);
    assert.match(text, /\/\/ ==\/UserScript==\n\n\(\(\) => \{/, "expected the IIFE wrapper after the header");
    assert.match(text.trimEnd(), /}\)\(\);$/, "the wrapper must be closed");
    assert.ok(text.includes("Kismet"), "the bundle banner should name the tool");
  });
});

describe("release/kismet-bootstrap.user.js", () => {
  const bootstrapPath = resolve(root, "release", "kismet-bootstrap.user.js");
  const ENGINE = "https://cdn.jsdelivr.net/gh/xylendevelopments/Kismet@main/release/kismet.user.js";

  it("is a small, valid userscript for the same site", async () => {
    const text = await readFile(bootstrapPath, "utf8");
    const lines = headerLines(text);
    assert.deepEqual(directive(lines, "name"), ["Kismet (bootstrap)"]);
    assert.ok(text.length < 8_000, `the bootstrap must stay tiny (${text.length} bytes)`);

    for (const pattern of directive(lines, "match")) {
      assert.match(pattern, MATCH_PATTERN, `invalid @match: ${pattern}`);
    }
    assert.ok(directive(lines, "match").some((pattern) => pattern.includes("webosu-online.netlify.app")));
  });

  it("loads the engine from the CDN and says so in the console", async () => {
    const text = await readFile(bootstrapPath, "utf8");
    assert.ok(text.includes(ENGINE), "must point at the published engine");
    assert.match(text, /console\.info\("\[Kismet\] bootstrap running on "/);
    assert.match(text, /if \(window\.Kismet\)/, "must not load the engine twice");
  });

  it("parses as JavaScript", async () => {
    const text = await readFile(bootstrapPath, "utf8");
    const body = text.slice(text.indexOf("// ==/UserScript==") + "// ==/UserScript==".length);
    assert.doesNotThrow(() => new Function(body));
  });
});
