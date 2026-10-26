# Tabletop Audio SoundPads (Foundry VTT)

Native, in-Foundry recreation of the [Tabletop Audio](https://tabletopaudio.com)
**SoundPads**: layered ambience, one-shot effects and music, mixed live and
broadcast to your players — without an embedded website iframe.

> **Personal use only.** This module replays *your* access to Tabletop Audio
> content. TTA is funded on Patreon — please support them. Audio is **not**
> redistributed with this module; you download it yourself from TTA.

## How it works

1. **Pad data is pre-cached.** `tools/scrape_pads.mjs` reads each SoundPad's
   layout (tiles, labels, icons, categories, default volumes, loop/one-shot
   type, audio-sprite segments) and the audio URLs, and writes one JSON
   descriptor per pad into `packs/pads/`. This runs **offline, once** — during a
   session Foundry only reads these local JSON files, so the Foundry server is
   never bothered.
2. **Audio plays locally.** TTA's CDN blocks hotlinking (it requires a
   `tabletopaudio.com` Referer) *and* only allows cross-origin loads from its own
   origin. A browser inside Foundry can satisfy neither, so **direct streaming
   does not work**. Instead the scraper downloads the audio for you (it can set
   the right Referer), and Foundry serves it same-origin from
   `audio-cache/`. This also means it works fully offline.

## Setup

```bash
cd modules/tabletop-audio-soundpads/tools

# 1. Pad layouts only (fast — already done; ~33 pads):
node scrape_pads.mjs

# 2. Download the audio for the pads you actually use (recommended):
node scrape_pads.mjs dungeon tavern combat --download
#    or everything (large — hundreds of MB):
node scrape_pads.mjs --download
```

Then enable **Tabletop Audio SoundPads** in *Manage Modules*. Open the pad from
the **Ambient Sounds** scene-control toolbar (the record icon), or via
`game.modules.get("tabletop-audio-soundpads").api.open()`.

## Usage

The window opens on a **picker** with two tabs:

- **SoundPads** — a cover-art gallery of the 33 pads; click a pad to open its board.
- **Soundscapes** — the ~500 original 10-minute looping ambiences, filterable by
  44 genre tags. Click a track to play it (mutually exclusive — one ambience at a
  time). Soundscape audio is large (~14 MB each); download what you want with
  `node scrape_soundscapes.mjs --audio <genre|number|all>`.

On a pad board (▦ returns to the picker):

- **Category tabs** filter tiles (Backgrounds / Tones / Creatures / Events / Music).
- **Click a tile** to play it. The little **loop button** (top-left) decides how:
  loop on → it loops continuously until you click again (or unpress loop);
  loop off → it fires once. Defaults match Tabletop Audio (backgrounds loop,
  events one-shot). Sprite-backed effects (e.g. "Attack x4") pick a random
  variation each time.
- **Repeat dropdown** (one-shots, when loop is off) auto-replays the sound at a
  chosen interval with random jitter — Tabletop Audio's "Every N sec." feature.
- **Per-tile slider** sets that layer's volume (live while playing), pulled from
  Tabletop Audio's own defaults.
- **Broadcast** toggle (GM): mirror the mix to every player's client, or keep it
  GM-only. Players who join mid-session ask the GM to resync the current mix.

Ambience/one-shots route through Foundry's *Environment* audio bus and music
through the *Music* bus, so each user's Foundry volume sliders apply.

## Settings

- **Audio source** — *Local copy* (recommended) or *CDN* (usually blocked, see above).
- **Broadcast to players** — default on.

## Limitations

- Local cache stores `.ogg` only. Foundry's Electron client and Chrome/Firefox
  decode OGG fine; Safari players would need `.mp3` (not yet downloaded).
- Re-running the scraper refreshes layouts but does not delete already-downloaded
  audio.
