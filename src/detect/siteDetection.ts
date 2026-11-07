import {
  DEV_HOST_PATTERN,
  KNOWN_APEXES,
  KNOWN_HOSTS,
  SITE_NAME,
} from "../constants";

export type SiteVerdict = "confirmed" | "probable" | "unknown";

export interface SiteCheck {
  verdict: SiteVerdict;
  host: string;
  message: string;
}

export const NOT_DETECTED_MESSAGE = `${SITE_NAME} not detected.`;

/** True for a known webosu! deployment host. */
export function isKnownHost(host: string): boolean {
  const h = host.toLowerCase();
  if (KNOWN_HOSTS.includes(h)) return true;
  return KNOWN_APEXES.some((apex) => h.endsWith(`.${apex}`));
}

/**
 * Determine whether the current page is webosu!.
 *
 * Three tiers, cheapest first:
 *   1. Hostname match (or a subdomain of a known apex)  -> confirmed
 *   2. Localhost dev server                             -> probable
 *   3. DOM/global fingerprint (Pixi canvas + the site's globals) -> probable
 *
 * The fingerprint exists because webosu! has been mirrored on several hosts
 * already; a mirror should not silently disable the tool. It is deliberately
 * structural — the site's own `game`/`playback` globals plus a canvas — rather
 * than matching class names that a restyle would churn.
 */
export function detectSite(win: Window = window): SiteCheck {
  const host = (win.location?.hostname ?? "").toLowerCase();
  const anyWin = win as unknown as Record<string, unknown>;

  if (isKnownHost(host)) {
    return { verdict: "confirmed", host, message: `${SITE_NAME} (${host})` };
  }

  if (DEV_HOST_PATTERN.test(host)) {
    return {
      verdict: "probable",
      host,
      message: `Local dev server (${host}) — assuming ${SITE_NAME}`,
    };
  }

  if (anyWin.game && anyWin.playback) {
    return {
      verdict: "probable",
      host,
      message: `Unrecognised host (${host}) but the page exposes ${SITE_NAME}'s game objects`,
    };
  }

  if (matchesDomFingerprint(win)) {
    return {
      verdict: "probable",
      host,
      message: `Unrecognised host (${host}) but the page looks like ${SITE_NAME}`,
    };
  }

  return { verdict: "unknown", host, message: NOT_DETECTED_MESSAGE };
}

/** Structural fingerprint: a Pixi canvas plus the site's own branding. */
function matchesDomFingerprint(win: Window): boolean {
  const doc = win.document;
  if (!doc?.querySelector) return false;

  const canvas = doc.querySelector("canvas");
  const text = `${doc.title ?? ""} ${(doc.body as HTMLElement | null)?.innerText?.slice(0, 4000) ?? ""}`.toLowerCase();
  const mentions = text.includes("webosu") || text.includes("osu!");

  // The site's skin loader sets `window.Skin` to a texture table and its
  // bootstrap publishes `window.Playback`; either is a cheap proxy for
  // "this page is running webosu!".
  const anyWin = win as unknown as Record<string, unknown>;
  const siteGlobals = typeof anyWin.Playback === "function" || !!anyWin.Skin;

  return !!canvas && (mentions || siteGlobals);
}
