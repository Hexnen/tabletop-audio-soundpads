import { SoundPadEngine } from "./engine.mjs";
import { SoundPadApp } from "./soundpad-app.mjs";

export const MODULE_ID = "tabletop-audio-soundpads";
export const SOCKET = `module.${MODULE_ID}`;
const PADS_PATH = `modules/${MODULE_ID}/packs/pads`;
const SOUNDSCAPES_PATH = `modules/${MODULE_ID}/packs/soundscapes.json`;
export const SOUNDSCAPE_PAD = "_soundscapes";

/** Module-wide singletons, reachable via game.modules.get(MODULE_ID).api */
export const TAS = {
  engine: null,
  index: [],
  padCache: new Map(),
  soundscapes: null, // { genres:[], tracks:[] }
  /** Load (and memoize) a single pad descriptor. */
  async getPad(padId) {
    if (this.padCache.has(padId)) return this.padCache.get(padId);
    const pad = await foundry.utils.fetchJsonWithTimeout(`${PADS_PATH}/${padId}.json`);
    this.padCache.set(padId, pad);
    return pad;
  },
  /** Synthesize an engine "layer" from a soundscape track. */
  soundscapeLayer(track) {
    return {
      id: `ss_${track.num}`,
      label: track.title,
      type: "soundscape",
      loop: true,
      gain: 0.6,
      url: track.url,
      ogg: track.url,
      mp3: track.mp3 ?? track.url,
      local: track.local
    };
  },
  preferLocal() {
    return game.settings.get(MODULE_ID, "audioSource") === "local";
  },
  canBroadcast() {
    return game.user.isGM && game.settings.get(MODULE_ID, "broadcast");
  }
};

// --- settings ---------------------------------------------------------------

function registerSettings() {
  const { StringField, BooleanField } = foundry.data.fields;

  game.settings.register(MODULE_ID, "audioSource", {
    name: "TAS.Settings.AudioSource.Name",
    hint: "TAS.Settings.AudioSource.Hint",
    scope: "world",
    config: true,
    type: new StringField({
      required: true,
      initial: "local",
      choices: { local: "TAS.Settings.AudioSource.Local", cdn: "TAS.Settings.AudioSource.Cdn" }
    })
  });

  game.settings.register(MODULE_ID, "broadcast", {
    name: "TAS.Settings.Broadcast.Name",
    hint: "TAS.Settings.Broadcast.Hint",
    scope: "world",
    config: true,
    type: new BooleanField({ initial: true })
  });

  // Remembers the last-opened pad so the window reopens where you left it.
  game.settings.register(MODULE_ID, "lastPad", {
    scope: "client",
    config: false,
    type: new StringField({ required: false, initial: "" })
  });
}

// --- socket -----------------------------------------------------------------

function wireSocket() {
  game.socket.on(SOCKET, async (msg) => {
    if (!msg || typeof msg !== "object") return;
    const { action } = msg;
    const eng = TAS.engine;
    const preferLocal = TAS.preferLocal();

    switch (action) {
      // Looping layers sync natively via PlaylistSound documents — only the
      // transient one-shots and auto-repeats are mirrored over the socket.
      case "oneshot": {
        const layer = await resolveLayer(msg);
        if (layer) await eng.playOneShot(msg.padId, layer, { volume: msg.volume, preferLocal });
        break;
      }
      case "repeat": {
        const layer = await resolveLayer(msg);
        if (layer) eng.setRepeat(msg.padId, layer, msg.interval, { volume: msg.volume, preferLocal });
        break;
      }
      case "clearRepeat":
        eng.clearRepeat(msg.padId, msg.layerId);
        break;
      case "stopManual":
        eng.stopManual();
        break;
    }
  });
}

export function emit(payload) {
  game.socket.emit(SOCKET, payload);
}

// A soundscape message carries its own layer; pad messages reference a layerId.
async function resolveLayer(msg) {
  if (msg.layer) return msg.layer;
  const pad = await TAS.getPad(msg.padId).catch(() => null);
  return pad?.layers.find((l) => l.id === msg.layerId) ?? null;
}

// --- scene controls (the toolbar button) ------------------------------------

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  // v13+ controls is a record keyed by control name.
  const sounds = controls.sounds ?? controls.find?.((c) => c.name === "sounds");
  if (!sounds) return;
  const tool = {
    name: "tas-soundpad",
    title: "TAS.OpenPad",
    icon: "fa-solid fa-record-vinyl",
    button: true,
    onChange: () => SoundPadApp.open(),
    onClick: () => SoundPadApp.open()
  };
  if (Array.isArray(sounds.tools)) sounds.tools.push(tool);
  else sounds.tools[tool.name] = tool;
});

// --- lifecycle --------------------------------------------------------------

Hooks.once("init", () => {
  registerSettings();
  TAS.engine = new SoundPadEngine();
});

Hooks.once("ready", async () => {
  wireSocket();
  try {
    const idx = await foundry.utils.fetchJsonWithTimeout(`${PADS_PATH}/index.json`);
    TAS.index = idx.pads ?? [];
  } catch (err) {
    console.error(`${MODULE_ID} | could not load pad index`, err);
    TAS.index = [];
  }

  try {
    TAS.soundscapes = await foundry.utils.fetchJsonWithTimeout(SOUNDSCAPES_PATH);
  } catch (err) {
    TAS.soundscapes = { genres: [], tracks: [] };
  }

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { TAS, open: () => SoundPadApp.open() };

  // Ensure the managed playlist exists (GM). Foundry then plays/syncs/resumes
  // every looping layer from its documents — including across reloads and for
  // players after the GM disconnects. Nothing else to restore.
  try {
    TAS.engine.initPlaylist();
    TAS.engine.startPositionSaver(); // GM: keep pausedTime fresh for resume + re-sync
  } catch (err) {
    console.error(`${MODULE_ID} | could not init playlist`, err);
  }

  // Keep the open window in step with native playlist sync on every client.
  const rerender = (doc, changes) => {
    if (!doc?.parent?.getFlag?.(MODULE_ID, "managed")) return;
    // The 10s position-saver only touches pausedTime — don't re-render for that.
    if (changes && Object.keys(changes).every((k) => k === "pausedTime" || k === "_id")) return;
    for (const app of foundry.applications.instances.values()) {
      if (app instanceof SoundPadApp) app.render();
    }
  };
  Hooks.on("createPlaylistSound", rerender);
  Hooks.on("updatePlaylistSound", rerender);
  Hooks.on("deletePlaylistSound", rerender);

  // GM: tidy up managed sounds once they stop (manual stop or a one-shot that
  // reached its end) — delete after the fade so it doesn't cut off.
  Hooks.on("updatePlaylistSound", (doc, changes) => {
    if (!game.user.isGM) return;
    if (!doc?.parent?.getFlag?.(MODULE_ID, "managed")) return;
    if (changes?.playing === false) {
      window.setTimeout(() => doc.delete().catch(() => {}), 700);
    }
  });

  console.log(`${MODULE_ID} | ready — ${TAS.index.length} pads`);
});
