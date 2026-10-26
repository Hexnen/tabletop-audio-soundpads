#!/usr/bin/env node
// Tabletop Audio SoundPad scraper — run OFFLINE, never during a game session.
//
// Pulls each SoundPad "recipe" (tile layout + audio URLs) from tabletopaudio.com
// once and writes a self-contained JSON descriptor per pad into ../packs/pads/.
// At play time the Foundry module reads only those local JSON files, so the
// Foundry server never talks to TTA — only each player's browser streams the
// ogg/mp3 directly from sounds.tabletopaudio.com (or a local cache).
//
// Usage:
//   node scrape_pads.mjs                 # scrape all pads -> JSON descriptors
//   node scrape_pads.mjs dungeon tavern  # scrape only the named pads
//   node scrape_pads.mjs --download      # also download audio into ../audio-cache/
//   node scrape_pads.mjs --concurrency=4
//
// Node 18+ (global fetch). No external dependencies.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "packs", "pads");
const AUDIO_DIR = path.resolve(__dirname, "..", "audio-cache");
// Foundry Data root: tools -> module -> modules -> Data
const DATA_ROOT = path.resolve(__dirname, "..", "..", "..");

const BASE = "https://tabletopaudio.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Index entries that aren't real ambience pads.
const SKIP = new Set(["custom", "dm_tools"]);

// The categories TTA uses as mixitup filters on every pad.
const KNOWN_CATEGORIES = new Set([
  "backgrounds", "tones", "creatures", "events", "music"
]);

// TTA's freq selector value (its odd "minutes") -> seconds for our UI.
const FREQ_SECONDS = {
  "0": 0, ".15": 10, ".25": 15, ".5": 30, "1": 60,
  "2": 120, "3": 180, "5": 300, "15": 900, "30": 1800
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const concArg = args.find((a) => a.startsWith("--concurrency="));
const CONCURRENCY = concArg ? Number(concArg.split("=")[1]) : 4;
const DOWNLOAD = flags.has("--download");
const onlyPads = args.filter((a) => !a.startsWith("--"));

// --- fetch helpers ----------------------------------------------------------

// The `Sec-Fetch-Dest` header is what slips past TTA's ModSecurity rules.
async function getText(url, dest = "document") {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": dest === "script" ? "*/*" : "text/html,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": BASE + "/soundpad.html",
      "Sec-Fetch-Dest": dest,
      "Sec-Fetch-Mode": dest === "script" ? "no-cors" : "navigate",
      "Sec-Fetch-Site": "same-origin"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// --- parsing ----------------------------------------------------------------

// Per-pad thematic card image from the soundpad index (scene + title, no
// SoundPad/Tabletop branding). slug -> image URL. Populated by discoverPads.
const INDEX_CARDS = new Map();

/** Discover all pad slugs from the soundpad index page + their card images. */
async function discoverPads() {
  const html = await getText(BASE + "/soundpad.html");
  const slugs = new Set();
  for (const m of html.matchAll(/([a-z0-9_-]+)_sp\.html/gi)) {
    const slug = m[1].toLowerCase();
    if (!SKIP.has(slug)) slugs.add(slug);
  }
  // Pair each pad's launch link with the next card image (the clean thematic
  // card shown on soundpad.html), without crossing into the next card.
  const re =
    /href="([a-z0-9_-]+)_sp\.html"(?:(?!_sp\.html)[\s\S])*?data-src="([^"]+\.(?:jpg|png|webp))"/gi;
  for (const m of html.matchAll(re)) {
    const slug = m[1].toLowerCase();
    if (!SKIP.has(slug) && !INDEX_CARDS.has(slug)) INDEX_CARDS.set(slug, m[2]);
  }
  return [...slugs].sort();
}

/**
 * Parse the per-pad JS manifest into { id -> { url, ogg, mp3 } } plus the
 * music track ids. The JS looks like:
 *   var e="https://sounds.tabletopaudio.com/dungeon2/", a="...", t="...",
 *       t=[{src:e+"dungeon_bg1.ogg",id:"bg_1",data:1}, ...];
 *   ... musicTrack1="bg_16", musicTrack2="bg_17" ...
 */
function parseManifest(js) {
  // Collect host string vars: e="https://sounds.tabletopaudio.com/dungeon2/"
  const hosts = {};
  for (const m of js.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*=\s*"(https?:\/\/[^"]+\/)"/g
  )) {
    hosts[m[1]] = m[2]; // last assignment wins, which is what we want
  }

  const resolve = (hostVar, file) => {
    if (hostVar) {
      const host = hosts[hostVar];
      return host ? host + file : null;
    }
    return /^https?:\/\//.test(file) ? file : null;
  };
  const withFallback = (url) => ({
    url,
    ogg: url,
    // TTA serves an .mp3 alongside every .ogg (createjs alternateExtensions).
    mp3: url.replace(/\.ogg(\?.*)?$/i, ".mp3$1")
  });

  // (1) Simple entries: {src:e+"file.ogg",id:"bg_1",data:1}
  const sounds = {};
  const entryRe =
    /\{\s*src\s*:\s*(?:([A-Za-z_$][\w$]*)\s*\+\s*)?"([^"]+)"\s*,\s*id\s*:\s*"([^"]+)"/g;
  for (const m of js.matchAll(entryRe)) {
    const [, hostVar, file, id] = m;
    const url = resolve(hostVar, file);
    if (url) sounds[id] = withFallback(url);
  }

  // (2) Audio-sprite entries: one file sliced into timed segments, e.g.
  //     {src:e+"goblin_attack_x4.ogg",data:{audioSprite:[
  //        {id:"bg_6a",startTime:0,duration:2307}, {id:"bg_6b",...}, ...]}}
  // Each sprite id "bg_6a" belongs to tile "bg_6"; multiple letters are random
  // one-shot variations. Times are in milliseconds.
  const spriteRe =
    /src\s*:\s*(?:([A-Za-z_$][\w$]*)\s*\+\s*)?"([^"]+)"\s*,\s*data\s*:\s*\{\s*audioSprite\s*:\s*\[([\s\S]*?)\]\s*\}/g;
  for (const m of js.matchAll(spriteRe)) {
    const [, hostVar, file, body] = m;
    const url = resolve(hostVar, file);
    if (!url) continue;
    for (const s of body.matchAll(
      /\{\s*id\s*:\s*"([^"]+)"\s*,\s*startTime\s*:\s*([\d.]+)\s*,\s*duration\s*:\s*([\d.]+)/g
    )) {
      const base = s[1].replace(/[a-z]+$/i, ""); // bg_6a -> bg_6
      const seg = { offset: Number(s[2]) / 1000, duration: Number(s[3]) / 1000 };
      if (!sounds[base]) sounds[base] = { ...withFallback(url), sprites: [] };
      if (!sounds[base].sprites) sounds[base].sprites = [];
      sounds[base].sprites.push(seg);
    }
  }

  // Music track ids: musicTrack1="bg_16"
  const musicIds = new Set();
  for (const m of js.matchAll(/musicTrack\d+\s*=\s*"([^"]+)"/g)) {
    musicIds.add(m[1]);
  }

  return { sounds, musicIds };
}

/**
 * Parse the pad HTML into per-tile layout: label, icon, category, default gain,
 * loop-vs-oneshot, and whether it's a music tile.
 */
function parseTiles(html) {
  const tiles = [];
  // Split the document into tile blocks. Each tile starts with
  // <div id="bg_N" class="... mix CATEGORY ...">. Capture up to the next tile.
  const tileRe =
    /<div id="(bg_\d+)"\s+class="([^"]*)"[^>]*>([\s\S]*?)(?=<div id="bg_\d+"\s+class="|<\/body|$)/g;
  for (const m of html.matchAll(tileRe)) {
    const [, id, classList, body] = m;

    // Category = the mixitup filter token in the class list.
    const classes = classList.split(/\s+/).filter(Boolean);
    let category = classes.find((c) => KNOWN_CATEGORIES.has(c)) || "backgrounds";

    // Label + icon live in the .scrawl div: <div class="scrawl ...">LABEL<img src="ICON"></div>
    const scrawl = body.match(/class="scrawl[^"]*">([\s\S]*?)<\/div>/i);
    let label = id;
    let icon = null;
    if (scrawl) {
      const inner = scrawl[1];
      label = decodeEntities(inner.split("<")[0].trim()) || id;
      const iconM = inner.match(/<img[^>]*src="([^"]+)"/i);
      if (iconM) icon = iconM[1];
    }

    // Default gain from the volume slider: <div id="bg_N_gain" ... value=".35">
    const gainM = body.match(/_gain"[^>]*value="([^"]*)"/i);
    let gain = gainM ? parseFloat(gainM[1]) : 0.5;
    if (!Number.isFinite(gain)) gain = 0.5;

    // Loop checkbox: looping tiles render <input name="loop" ... checked>.
    const loopInput = body.match(/<input[^>]*name="loop"[^>]*>/i);
    const isMusic = /data-type="music"/i.test(body);
    const loop = loopInput ? /checked/i.test(loopInput[0]) : false;

    const type = isMusic ? "music" : loop ? "loop" : "oneshot";

    // TTA's default auto-repeat interval for this tile (data-freq), in seconds.
    const freqM = body.match(/data-freq="([^"]*)"/i);
    const repeatDefault = freqM ? (FREQ_SECONDS[freqM[1]] ?? 0) : 0;

    tiles.push({ id, label, icon, category, gain, loop, type, repeatDefault });
  }
  return tiles;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function titleCase(slug) {
  return slug
    .split(/[_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// --- per-pad pipeline -------------------------------------------------------

async function scrapePad(slug) {
  const html = await getText(`${BASE}/${slug}_sp.html`, "document");

  // Find the pad's data JS: <script src="bootstrap/js/sp_<...>_min.js">
  const jsMatch = html.match(
    /<script[^>]*src="((?:bootstrap\/js\/)?sp_[a-z0-9_]*?(?:simple_)?min\.js[^"]*)"/i
  );
  if (!jsMatch) throw new Error(`no pad JS <script> found for ${slug}`);
  const jsUrl = new URL(jsMatch[1], `${BASE}/`).href;
  const js = await getText(jsUrl, "script");

  const { sounds, musicIds } = parseManifest(js);
  const rawTiles = parseTiles(html);

  // Pad display name. TTA <title> is usually just "Tabletop Audio", so derive
  // from the slug; only trust <title> if it carries a more specific tail.
  let name = titleCase(slug);
  const titleM = html.match(/<title>([^<]*)<\/title>/i);
  if (titleM) {
    const tail = decodeEntities(titleM[1].trim()).split(/\s*[-|]\s*/).pop().trim();
    if (tail && !/tabletop\s*audio/i.test(tail) && !/soundpad/i.test(tail)) {
      name = tail;
    }
  }

  const layers = [];
  let missing = 0;
  for (const t of rawTiles) {
    const snd = sounds[t.id];
    if (!snd) {
      missing++;
      continue; // tile has no backing sound in the manifest
    }
    // Sprite-backed tiles are always one-shot variations.
    const hasSprites = Array.isArray(snd.sprites) && snd.sprites.length > 0;
    const type = musicIds.has(t.id) ? "music" : hasSprites ? "oneshot" : t.type;
    const fileName = snd.ogg.split("/").pop().split("?")[0];
    // images.tabletopaudio.com is hotlink-protected too, so icons must be local.
    const iconFile = t.icon ? t.icon.split("/").pop().split("?")[0] : null;
    const layer = {
      id: t.id,
      label: t.label,
      icon: iconFile
        ? `modules/tabletop-audio-soundpads/audio-cache/${slug}/icons/${iconFile}`
        : null,
      iconRemote: t.icon,
      category: type === "music" ? "music" : t.category,
      type,
      loop: type === "oneshot" ? false : true,
      gain: t.gain,
      // TTA's default auto-repeat interval (seconds; 0 = off) for one-shots.
      repeatDefault: type === "oneshot" ? t.repeatDefault ?? 0 : 0,
      url: snd.url,
      ogg: snd.ogg,
      mp3: snd.mp3,
      // Stable local path used when audioSource = "local". Populated on disk by
      // running with --download; the path is recorded either way.
      local: `modules/tabletop-audio-soundpads/audio-cache/${slug}/${fileName}`
    };
    if (hasSprites) layer.sprites = snd.sprites;
    layers.push(layer);
  }

  // Cover art for the picker gallery: the clean thematic card from soundpad.html
  // (scene + title, no SoundPad/Tabletop branding). Fall back to the og:image
  // promo composite only if the index card is missing.
  const ogM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  const coverRemote = INDEX_CARDS.get(slug) ?? (ogM ? ogM[1] : null);
  const coverFile = coverRemote ? coverRemote.split("/").pop().split("?")[0] : null;

  // Header art: the clean title banner TTA shows at the top of the pad page
  // (inside <span style="position:relative">) — no scene background.
  const hdrM = html.match(
    /<span style="position:relative">[\s\S]{0,300}?<img[^>]*\bsrc="([^"]+\.(?:png|jpg|jpeg|webp))"/i
  );
  const headerRemote = hdrM ? hdrM[1] : null;
  const headerFile = headerRemote ? headerRemote.split("/").pop().split("?")[0] : null;

  const categories = [...new Set(layers.map((l) => l.category))];
  return {
    pad: {
      id: slug,
      name,
      source: `${BASE}/${slug}_sp.html`,
      coverRemote,
      cover: coverFile
        ? `modules/tabletop-audio-soundpads/audio-cache/${slug}/${coverFile}`
        : null,
      headerRemote,
      header: headerFile
        ? `modules/tabletop-audio-soundpads/audio-cache/${slug}/${headerFile}`
        : null,
      categories,
      layerCount: layers.length,
      layers
    },
    stats: { tiles: rawTiles.length, mapped: layers.length, missing }
  };
}

// --- audio download (optional) ---------------------------------------------

async function downloadMedia(pad, url, destPath) {
  try {
    await fs.access(destPath);
    return "skip"; // already cached
  } catch {}
  try {
    // The CDN/image host refuses requests whose Referer/Origin isn't
    // tabletopaudio.com (hotlink protection). curl/Node can set these; a
    // browser inside Foundry cannot — which is exactly why we pre-download.
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Referer": BASE + `/${pad.id}_sp.html`, "Origin": BASE }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return "ok";
  } catch (e) {
    return "fail";
  }
}

async function downloadIcons(pad) {
  const padDir = path.join(AUDIO_DIR, pad.id);
  const dir = path.join(padDir, "icons");
  await fs.mkdir(dir, { recursive: true });

  // Pad cover (composite, for picker cards) + header (clean title banner).
  for (const remote of [pad.coverRemote, pad.headerRemote]) {
    if (!remote) continue;
    const file = remote.split("/").pop().split("?")[0];
    await downloadMedia(pad, remote, path.join(padDir, file));
  }

  const seen = new Set();
  let ok = 0;
  for (const layer of pad.layers) {
    if (!layer.iconRemote) continue;
    const fileName = layer.iconRemote.split("/").pop().split("?")[0];
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    const r = await downloadMedia(pad, layer.iconRemote, path.join(dir, fileName));
    if (r !== "fail") ok++;
  }
  return ok;
}

async function downloadAudio(pad) {
  const dir = path.join(AUDIO_DIR, pad.id);
  await fs.mkdir(dir, { recursive: true });
  const seen = new Set();
  for (const layer of pad.layers) {
    const fileName = layer.ogg.split("/").pop().split("?")[0];
    if (seen.has(fileName)) continue; // sprite tiles share one file
    seen.add(fileName);
    const r = await downloadMedia(pad, layer.ogg, path.join(dir, fileName));
    process.stdout.write(r === "fail" ? "x" : ".");
  }
  process.stdout.write("\n");
}

// --- driver -----------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Always load the index (also fills INDEX_CARDS) so cover art works even when
  // scraping a single pad.
  const all = await discoverPads();
  const slugs = onlyPads.length ? onlyPads : all;
  console.log(`Scraping ${slugs.length} pad(s) -> ${OUT_DIR}\n`);

  const index = [];
  await mapLimit(slugs, CONCURRENCY, async (slug) => {
    try {
      const { pad, stats } = await scrapePad(slug);
      if (!flags.has("--no-icons")) await downloadIcons(pad);
      if (DOWNLOAD) await downloadAudio(pad);
      await fs.writeFile(
        path.join(OUT_DIR, `${slug}.json`),
        JSON.stringify(pad, null, 2) + "\n"
      );
      // "downloaded" = every unique audio file for this pad is present on disk.
      const uniqueAudio = [...new Set(pad.layers.map((l) => l.local))];
      const downloaded =
        uniqueAudio.length > 0 &&
        uniqueAudio.every((rel) => existsSync(path.join(DATA_ROOT, rel)));
      index.push({
        id: pad.id,
        name: pad.name,
        cover: pad.cover,
        header: pad.header,
        layerCount: pad.layerCount,
        categories: pad.categories,
        downloaded
      });
      const warn = stats.missing ? `  (!${stats.missing} unmapped)` : "";
      console.log(
        `  ${slug.padEnd(22)} ${String(stats.mapped).padStart(3)} layers${warn}`
      );
    } catch (e) {
      console.error(`  ${slug.padEnd(22)} FAILED: ${e.message}`);
    }
  });

  // Merge into any existing index so scraping a subset doesn't drop other pads.
  const byId = new Map();
  try {
    const prev = JSON.parse(await fs.readFile(path.join(OUT_DIR, "index.json"), "utf8"));
    for (const p of prev.pads ?? []) byId.set(p.id, p);
  } catch {}
  for (const p of index) byId.set(p.id, p);

  const merged = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify({ generated: null, pads: merged }, null, 2) + "\n"
  );
  console.log(`\nWrote index.json with ${merged.length} pad(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
