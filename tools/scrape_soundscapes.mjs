#!/usr/bin/env node
// Tabletop Audio *Soundscapes* scraper — the ~500 original 10-minute looping
// ambiences (separate from the SoundPads). Run OFFLINE.
//
// Builds packs/soundscapes.json (catalogue: number, title, genres, thumbnail,
// audio URL + local path) and downloads the small thumbnails. The audio tracks
// are ~14 MB each (~7 GB for everything), so they are NOT downloaded unless you
// ask — and you can scope the download by genre or track number.
//
// Usage:
//   node scrape_soundscapes.mjs                 # catalogue + thumbnails only
//   node scrape_soundscapes.mjs --audio fantasy # download audio for a genre
//   node scrape_soundscapes.mjs --audio 1 2 14  # download specific track numbers
//   node scrape_soundscapes.mjs --audio all     # download EVERYTHING (~7 GB!)
//
// Node 18+. No external dependencies.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "packs", "soundscapes.json");
const DIR = path.resolve(__dirname, "..", "audio-cache", "_soundscapes");
const DATA_ROOT = path.resolve(__dirname, "..", "..", "..");
const LOCAL_BASE = "modules/tabletop-audio-soundpads/audio-cache/_soundscapes";

const BASE = "https://tabletopaudio.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PLAYER_JS = "/bootstrap/js/tta4XFADE4_min.js";
const TAGS_JS = "/bootstrap/js/tags_data.js";

// mixitup classes that aren't genres.
const NON_GENRE = new Set(["mix", "col-md-3", "all"]);

const args = process.argv.slice(2);
const audioIdx = args.indexOf("--audio");
const wantAudio = audioIdx !== -1;
const audioScope = wantAudio ? args.slice(audioIdx + 1) : [];

async function get(url, dest = "document") {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": dest === "script" ? "*/*" : "text/html,*/*",
      "Referer": BASE + "/",
      "Sec-Fetch-Dest": dest,
      "Sec-Fetch-Mode": dest === "script" ? "no-cors" : "navigate",
      "Sec-Fetch-Site": "same-origin"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function download(url, dest) {
  if (existsSync(dest)) return "skip";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Referer": BASE + "/", "Origin": BASE }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return "ok";
  } catch {
    return "fail";
  }
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

// Authoritative list of playable tracks lives in the player JS:
//   var e="https://sounds.tabletopaudio.com/", ...
//   SongList={song_1:{title:"The Inner Core",artist:i,mp3:e+"1_The_Inner_Core.mp3"}, ...}
function parseSongList(js) {
  const hostM = js.match(/\b([A-Za-z_$][\w$]*)\s*=\s*"(https:\/\/sounds\.tabletopaudio\.com\/)"/);
  const host = hostM ? hostM[2] : "https://sounds.tabletopaudio.com/";
  const hostVar = hostM ? hostM[1] : "e";
  const out = new Map();
  const re = new RegExp(
    `song_(\\d+)\\s*:\\s*\\{\\s*title\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"[^}]*?mp3\\s*:\\s*${hostVar}\\s*\\+\\s*"([^"]+)"`,
    "g"
  );
  let m;
  while ((m = re.exec(js))) {
    const num = Number(m[1]);
    out.set(num, { num, title: decode(m[2]), file: m[3], url: host + m[3] });
  }
  return out;
}

// Broad "setting" genres (fantasy/scifi/…) live in each tile's mixitup classes.
function parseBroadGenres(html) {
  const out = new Map();
  const re = /<div class="col-md-3 mix ([^"]*)">[\s\S]*?id="keys_(\d+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const genres = m[1]
      .trim().split(/\s+/)
      .filter((g) => !NON_GENRE.has(g))
      .map((g) => (g === "scif" ? "scifi" : g)); // fix a TTA class typo
    out.set(Number(m[2]), genres);
  }
  return out;
}

// Thumbnails: the real 300x200 track image always has `width="300"` right after
// its data-src. Anchoring on that skips the logo links some themed tracks
// (Starforged, Fragged Empire…) carry in their caption.
function parseThumbs(html) {
  const out = new Map();
  const re = /id="keys_(\d+)"(?:(?!id="keys_)[\s\S])*?data-src="([^"]+)"\s+width="300"/g;
  let m;
  while ((m = re.exec(html))) out.set(Number(m[1]), m[2]);
  return out;
}

// Flavor text TTA shows on each track (used as the hover tooltip).
function parseFlavor(html) {
  const out = new Map();
  const re =
    /id="keys_(\d+)"(?:(?!id="keys_)[\s\S])*?class="[^"]*flavor[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const text = decode(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (text) out.set(Number(m[1]), text);
  }
  return out;
}

// Detailed use-case tags (the 40+ filters) come from tags_data.js:
//   var useCaseTags = { "515": { civ:[], biome:["forest"], mood:[...], action:[...] }, ... }
function parseTags(js) {
  const out = new Map();
  const re = /"(\d+)"\s*:\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(js))) {
    const tags = [];
    for (const t of m[2].matchAll(/"([a-z]+)"/g)) tags.push(t[1]);
    out.set(Number(m[1]), [...new Set(tags)]);
  }
  return out;
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  console.log("Fetching Tabletop Audio Soundscapes catalogue…");

  const [homeHtml, js, tagsJs] = await Promise.all([
    get(BASE + "/", "document"),
    get(BASE + PLAYER_JS, "script"),
    get(BASE + TAGS_JS, "script")
  ]);

  const songs = parseSongList(js);
  const broad = parseBroadGenres(homeHtml);
  const thumbs = parseThumbs(homeHtml);
  const flavors = parseFlavor(homeHtml);
  const tags = parseTags(tagsJs);
  console.log(`  ${songs.size} playable tracks, ${tags.size} tagged, ${thumbs.size} thumbs, ${flavors.size} flavors`);

  const genreSet = new Set();
  const tracks = [];
  for (const [num, song] of [...songs].sort((a, b) => a[0] - b[0])) {
    const genres = [
      ...new Set([...(broad.get(num) ?? []), ...(tags.get(num) ?? [])])
    ].sort();
    genres.forEach((g) => genreSet.add(g));
    const thumbRemote = thumbs.get(num) ?? null;
    const thumbFile = thumbRemote ? thumbRemote.split("/").pop().split("?")[0] : null;
    tracks.push({
      num,
      title: song.title,
      genres,
      flavor: flavors.get(num) ?? null,
      url: song.url,
      mp3: song.url,
      local: `${LOCAL_BASE}/${song.file}`,
      thumbRemote,
      thumb: thumbFile ? `${LOCAL_BASE}/thumbs/${thumbFile}` : null
    });
  }

  // Thumbnails (small) — always fetch so the picker has art.
  await fs.mkdir(path.join(DIR, "thumbs"), { recursive: true });
  let thumbOk = 0;
  const seenThumb = new Set();
  for (const t of tracks) {
    if (!t.thumbRemote) continue;
    // Save under the DECODED name (e.g. "bubbling pools.jpg"); the JSON path
    // keeps the %20-encoded form, which the browser decodes back to this on load.
    const file = decodeURIComponent(t.thumbRemote.split("/").pop().split("?")[0]);
    if (seenThumb.has(file)) continue;
    seenThumb.add(file);
    const r = await download(t.thumbRemote, path.join(DIR, "thumbs", file));
    if (r !== "fail") thumbOk++;
  }
  console.log(`  thumbnails: ${thumbOk}`);

  // Optional audio download.
  if (wantAudio) {
    const all = audioScope.includes("all");
    const nums = new Set(audioScope.filter((s) => /^\d+$/.test(s)).map(Number));
    const genres = new Set(audioScope.filter((s) => !/^\d+$/.test(s) && s !== "all"));
    const pick = (t) =>
      all || nums.has(t.num) || t.genres.some((g) => genres.has(g));
    const todo = tracks.filter(pick);
    console.log(
      `  downloading audio for ${todo.length} track(s) (~${Math.round(todo.length * 14)} MB)…`
    );
    let n = 0;
    for (const t of todo) {
      const r = await download(t.url, path.join(DIR, t.local.split("/").pop()));
      process.stdout.write(r === "fail" ? "x" : ".");
      if (++n % 50 === 0) process.stdout.write(` ${n}\n`);
    }
    process.stdout.write("\n");
  }

  // Mark which tracks have their audio on disk.
  for (const t of tracks) {
    t.downloaded = existsSync(path.join(DATA_ROOT, t.local));
  }

  await fs.writeFile(
    OUT,
    JSON.stringify(
      { generated: null, genres: [...genreSet].sort(), tracks },
      null,
      2
    ) + "\n"
  );
  const dl = tracks.filter((t) => t.downloaded).length;
  console.log(
    `\nWrote soundscapes.json — ${tracks.length} tracks, ${genreSet.size} genres, ${dl} audio on disk.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
