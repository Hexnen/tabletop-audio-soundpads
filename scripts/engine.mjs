/**
 * Audio engine.
 *
 * Looping layers (pad loops + soundscapes) are backed by native Foundry
 * PlaylistSound documents in a GM-owned managed playlist. Foundry then plays,
 * SYNCHRONIZES across clients, and RESUMES-at-position after a reload entirely
 * on its own (the document stores `playing`/`pausedTime`/`repeat`). So the GM
 * just creates/updates/deletes those documents; players need no engine action.
 *
 * One-shots and auto-repeating one-shots are transient SFX with no need for
 * sync, so they stay as manually-managed `foundry.audio.Sound` objects and are
 * mirrored to players over the module socket.
 */

const MODULE_ID = "tabletop-audio-soundpads";
const FADE_MS = 600;

// Pick the best source URL for this layer given the user's settings + browser.
const CAN_OGG = (() => {
  try {
    return !!document.createElement("audio").canPlayType("audio/ogg; codecs=vorbis");
  } catch {
    return false;
  }
})();

export class SoundPadEngine {
  /** The managed Playlist document holding all looping layers. */
  #pl = null;

  /** Auto-repeating one-shots, keyed by `${padId}::${layerId}`. */
  #repeaters = new Map();
  /** Currently-sounding one-shots (for progress bars), keyed by tile key. */
  #oneshots = new Map();
  /** Debounced PlaylistSound volume writes, keyed by tile key. */
  #volTimers = new Map();
  /** Periodic position-saver interval (GM). */
  #posTimer = null;
  /** Counter for unique one-shot-document keys (so rapid clicks overlap). */
  #oneCounter = 0;

  // --- managed playlist -----------------------------------------------------

  /** Cache the managed playlist if it already exists (created lazily on play). */
  initPlaylist() {
    this.#pl = game.playlists?.find((p) => p.getFlag(MODULE_ID, "managed")) ?? null;
    return this.#pl;
  }

  /**
   * GM-only: every 10s, write each playing layer's LIVE position into its
   * PlaylistSound's `pausedTime`. Foundry resumes a playing sound from
   * `pausedTime` on reload, so this keeps the resume anchor fresh (otherwise it
   * stays 0 and every client restarts the track from the beginning). It also
   * re-aligns players to the GM's position, correcting drift.
   */
  startPositionSaver() {
    if (this.#posTimer || !game.user.isGM) return;
    this.#posTimer = window.setInterval(() => {
      for (const s of this.#livePlaylistSounds()) {
        const t = s.sound?.currentTime;
        if (typeof t === "number" && t > 0) {
          s.update({ pausedTime: t }, { diff: false, render: false }).catch(() => {});
        }
      }
    }, 10000);
  }

  get playlist() {
    if (!this.#pl) {
      this.#pl = game.playlists?.find((p) => p.getFlag(MODULE_ID, "managed")) ?? null;
    }
    return this.#pl;
  }

  resolveSrc(layer, { preferLocal } = {}) {
    if (preferLocal && layer.local) return layer.local;
    return CAN_OGG ? (layer.ogg ?? layer.url) : (layer.mp3 ?? layer.url);
  }

  /**
   * Resume Foundry's audio contexts. Browsers start them SUSPENDED until a user
   * gesture; clicks inside an ApplicationV2 window don't always reach Foundry's
   * auto-unlock, so sounds get queued and only flush on a later interaction
   * (the "plays on the second click / all at once" bug). Call this at the start
   * of every play action — it runs inside the click gesture, so resume() works.
   */
  async ensureAudioReady() {
    const a = game.audio;
    if (!a) return;
    // 1) Resume the raw contexts (needed for manual one-shot Sounds).
    const ctxs = [a.music, a.environment, a.interface].filter((c) => c?.state === "suspended");
    await Promise.all(ctxs.map((c) => c.resume().catch(() => {})));
    // 2) Clear Foundry's gesture lock — PlaylistSound playback (our loops) is
    //    deferred into `game.audio.pending` while `locked` is true. Flipping it
    //    here (inside the click gesture) lets loops start immediately, and we
    //    flush anything already queued so it plays now rather than "all at once
    //    on the next click".
    if (a.locked) {
      try { a.locked = false; } catch {}
      const pending = a.pending;
      if (Array.isArray(pending) && pending.length) {
        for (const fn of pending.splice(0, pending.length)) {
          try { fn(); } catch {}
        }
      }
    }
  }

  key(padId, layerId) {
    return `${padId}::${layerId}`;
  }

  #find(key) {
    return this.playlist?.sounds.find((s) => s.getFlag(MODULE_ID, "key") === key) ?? null;
  }

  /** Managed PlaylistSounds that are currently playing. */
  #livePlaylistSounds() {
    return (this.playlist?.sounds ?? []).filter((s) => s.playing && s.getFlag(MODULE_ID, "key"));
  }

  // --- queries (used by the UI) --------------------------------------------

  isActive(padId, layerId) {
    return !!this.#find(this.key(padId, layerId))?.playing;
  }

  isRepeating(padId, layerId) {
    return this.#repeaters.has(this.key(padId, layerId));
  }

  isLooping(padId, layerId) {
    return this.#find(this.key(padId, layerId))?.repeat !== false;
  }

  // Volume is exchanged with the UI in Foundry's perceptual "input" space (what
  // its playlist sliders show), and stored on the document as a raw gain — so
  // our sliders read identically to Foundry's native "currently playing" UI.
  #toGain(input) {
    return foundry.audio.AudioHelper.inputToVolume(input);
  }
  #toInput(gain) {
    return foundry.audio.AudioHelper.volumeToInput(gain);
  }

  /** The live (synced) volume of an active layer in input space, or null. */
  getVolume(padId, layerId) {
    const v = this.#find(this.key(padId, layerId))?.volume;
    return typeof v === "number" ? this.#toInput(v) : null;
  }

  /** Snapshot of looping layers + repeaters, for the "now playing" drawer. */
  getState() {
    const layers = [];
    for (const s of this.#livePlaylistSounds()) {
      const f = s.flags?.[MODULE_ID] ?? {};
      layers.push({
        key: f.key,
        padId: f.padId,
        layerId: f.layerId,
        label: s.name,
        volume: s.volume,
        loop: s.repeat !== false,
        oneshot: f.oneshot === true,
        type: f.type
      });
    }
    const repeats = [];
    for (const [key, r] of this.#repeaters) {
      repeats.push({ key, padId: r.padId, layerId: r.layer.id, interval: r.interval, label: r.layer.label });
    }
    return { layers, repeats };
  }

  /** Playback position (0..1) of every sounding layer + one-shot. */
  getPlaybacks() {
    const out = [];
    for (const s of this.#livePlaylistSounds()) {
      const snd = s.sound;
      const dur = snd?.duration || 0;
      const prog = dur ? ((snd.currentTime || 0) % dur) / dur : 0;
      const f = s.flags?.[MODULE_ID] ?? {};
      out.push({ padId: f.padId, layerId: f.layerId, progress: prog });
    }
    for (const [, o] of this.#oneshots) {
      const dur = o.duration || o.sound.duration || 0;
      const prog = dur ? Math.min(1, ((o.sound.currentTime || 0) - o.offset) / dur) : 0;
      out.push({ padId: o.padId, layerId: o.layerId, progress: Math.max(0, prog) });
    }
    return out;
  }

  /** Countdown (0..1) toward each repeater's next fire. */
  getRepeats() {
    const now = performance.now();
    const out = [];
    for (const [, r] of this.#repeaters) {
      const prog = r.waitMs ? Math.min(1, (now - r.startAt) / r.waitMs) : 0;
      out.push({ padId: r.padId, layerId: r.layer.id, progress: prog });
    }
    return out;
  }

  // --- looping layers (PlaylistSound-backed; GM only) ----------------------

  /**
   * Toggle a looping ambience/music/soundscape layer. Backed by a native
   * PlaylistSound so Foundry handles sync + resume for every client.
   * @returns {Promise<boolean>} the new on/off state.
   */
  async toggleLoop(padId, layer, { volume, preferLocal, loop = true, fade = true } = {}) {
    if (!game.user.isGM) return this.isActive(padId, layer.id);
    const pl = await this.#ensurePlaylist();
    if (!pl) return false;
    const key = this.key(padId, layer.id);

    const existing = this.#find(key);
    if (existing?.playing) {
      await this.#stopSound(existing, fade);
      return false;
    }

    // Music tiles and soundscapes are each mutually exclusive within their kind.
    if (layer.type === "music" || layer.type === "soundscape") {
      for (const s of this.#livePlaylistSounds()) {
        if (s.getFlag(MODULE_ID, "type") === layer.type) await this.#stopSound(s, fade);
      }
    }

    // `volume` arrives in input space; default from the layer's gain.
    const inputVol = volume ?? this.#toInput(layer.gain ?? 0.5);
    const gain = this.#toGain(inputVol);
    const src = this.resolveSrc(layer, { preferLocal });
    let snd = existing;
    if (!snd) {
      // Create stopped, then playSound() to actually START playback (creating
      // with playing:true sets the field but does NOT begin audio).
      [snd] = await pl.createEmbeddedDocuments("PlaylistSound", [
        {
          name: layer.label || layer.id,
          path: src,
          repeat: loop,
          volume: gain,
          fade: fade ? FADE_MS : 0,
          channel: layer.type === "soundscape" ? "music" : "environment",
          pausedTime: 0,
          flags: { [MODULE_ID]: { key, padId, layerId: layer.id, type: layer.type } }
        }
      ]);
    } else {
      await snd.update({ repeat: loop, volume: gain });
    }
    // playSound sets playing:true and triggers sync() → it shows in Currently
    // Playing AND the audio actually starts.
    await pl.playSound(snd);
    return true;
  }

  async stopLayer(padId, layerId) {
    const snd = this.#find(this.key(padId, layerId));
    if (snd) await this.#stopSound(snd);
  }

  /** Stop one specific managed sound by its exact flag key (loops or one-shots). */
  async stopByKey(key) {
    const snd = this.playlist?.sounds.find((s) => s.getFlag(MODULE_ID, "key") === key);
    if (snd) await this.#stopSound(snd);
  }

  /**
   * Fire a one-shot as a transient PlaylistSound so it shows in Foundry's
   * "Currently Playing" and is synced to players. A unique key lets rapid clicks
   * overlap; it auto-deletes when it ends (see the cleanup hook). For sprite
   * effects pass a segment {offset,duration}: it starts at that offset
   * (pausedTime) and is stopped after the segment's length.
   */
  async playOneShotDoc(padId, layer, { volume, preferLocal, segment } = {}) {
    if (!game.user.isGM) return;
    const pl = await this.#ensurePlaylist();
    if (!pl) return;
    const gain = this.#toGain(volume ?? this.#toInput(layer.gain ?? 0.7));
    const oneKey = `${this.key(padId, layer.id)}#${this.#oneCounter++}`;
    await pl.createEmbeddedDocuments("PlaylistSound", [
      {
        name: layer.label || layer.id,
        path: this.resolveSrc(layer, { preferLocal }),
        repeat: false,
        volume: gain,
        fade: 0,
        channel: layer.type === "soundscape" ? "music" : "environment",
        playing: true,
        pausedTime: segment ? segment.offset : 0,
        flags: { [MODULE_ID]: { key: oneKey, padId, layerId: layer.id, type: layer.type, oneshot: true } }
      }
    ]);
    if (segment) {
      // Cut the sprite at the end of its window (the file holds several).
      window.setTimeout(() => this.stopByKey(oneKey), (segment.duration + 0.05) * 1000);
    }
  }

  /**
   * Adjust a looping layer's volume. Single source of truth = the PlaylistSound
   * document (Foundry applies it identically on every client), so the displayed
   * % always matches what's actually heard. Debounced to avoid DB spam.
   */
  setVolume(padId, layerId, input) {
    const key = this.key(padId, layerId);
    const snd = this.#find(key);
    if (!snd) return;
    const gain = this.#toGain(input);
    clearTimeout(this.#volTimers.get(key));
    this.#volTimers.set(
      key,
      window.setTimeout(() => {
        // No render:false — Foundry must re-render its own "currently playing"
        // slider so the two stay in sync.
        if (game.user.isGM) snd.update({ volume: gain }).catch(() => {});
      }, 150)
    );
  }

  /** Change a looping layer's loop mode (off = play to the end then stop). */
  async setItemLoop(padId, layerId, loop) {
    if (!game.user.isGM) return;
    const snd = this.#find(this.key(padId, layerId));
    if (snd) await snd.update({ repeat: loop });
  }

  async #ensurePlaylist() {
    if (this.playlist) return this.#pl;
    if (game.user.isGM) {
      this.#pl = await Playlist.create({
        name: "Tabletop Audio (live mix)",
        mode: CONST.PLAYLIST_MODES.SIMULTANEOUS,
        flags: { [MODULE_ID]: { managed: true } }
      });
    }
    return this.#pl;
  }

  async #stopSound(snd) {
    // Sets playing:false (fading per the sound's `fade`). The playing->false
    // cleanup hook then deletes the document (after the fade), which also covers
    // one-shots that end on their own.
    try {
      await this.playlist?.stopSound(snd);
    } catch {}
  }

  // --- one-shots (manual Sound; mirrored to players via socket) ------------

  #contextFor(type) {
    const a = game.audio;
    if (type === "music" || type === "soundscape") return a.music;
    return a.environment ?? a.music;
  }

  async #makeSound(layer, { preferLocal } = {}) {
    const sound = game.audio.create({
      src: this.resolveSrc(layer, { preferLocal }),
      context: this.#contextFor(layer.type),
      singleInstance: false,
      autoplay: false
    });
    await sound.load();
    return sound;
  }

  async playOneShot(padId, layer, { volume, preferLocal } = {}) {
    const vol = volume ?? layer.gain ?? 0.7;
    let sound;
    try {
      sound = await this.#makeSound(layer, { preferLocal });
    } catch (err) {
      console.error(`${MODULE_ID} | failed to load`, layer, err);
      return;
    }
    const key = this.key(padId, layer.id);
    const play = { loop: false, volume: vol };
    let entry;
    if (Array.isArray(layer.sprites) && layer.sprites.length) {
      const seg = layer.sprites[Math.floor(Math.random() * layer.sprites.length)];
      play.offset = seg.offset;
      sound.play(play);
      entry = { sound, padId, layerId: layer.id, offset: seg.offset, duration: seg.duration };
      sound.schedule?.(() => sound.stop(), seg.offset + seg.duration);
      window.setTimeout(() => { try { sound.stop(); } catch {} }, (seg.duration + 0.05) * 1000);
    } else {
      sound.play(play);
      entry = { sound, padId, layerId: layer.id, offset: 0, duration: sound.duration || 0 };
    }
    this.#oneshots.set(key, entry);
    const drop = () => { if (this.#oneshots.get(key)?.sound === sound) this.#oneshots.delete(key); };
    sound.addEventListener?.("stop", drop);
    sound.addEventListener?.("end", drop);
  }

  // --- auto-repeat (manual; mirrored to players via socket) ----------------

  setRepeat(padId, layer, interval, { volume, preferLocal } = {}) {
    const key = this.key(padId, layer.id);
    this.clearRepeat(padId, layer.id);
    if (!interval || interval <= 0) return;
    const vol = volume ?? layer.gain ?? 0.7;
    const r = { padId, layer, interval, volume: vol, id: null, startAt: 0, waitMs: 0 };
    this.#repeaters.set(key, r);
    const schedule = () => {
      const next = interval * (0.6 + Math.random() * 0.8) * 1000;
      r.startAt = performance.now();
      r.waitMs = next;
      r.id = window.setTimeout(() => {
        this.playOneShot(padId, layer, { volume: vol, preferLocal });
        schedule();
      }, next);
    };
    schedule();
  }

  clearRepeat(padId, layerId) {
    const key = this.key(padId, layerId);
    const r = this.#repeaters.get(key);
    if (r) {
      window.clearTimeout(r.id);
      this.#repeaters.delete(key);
    }
  }

  /** Stop transient sounds (one-shots + repeaters) — used on every client. */
  stopManual() {
    for (const [, r] of [...this.#repeaters]) window.clearTimeout(r.id);
    this.#repeaters.clear();
    for (const [, o] of [...this.#oneshots]) { try { o.sound.stop(); } catch {} }
    this.#oneshots.clear();
  }

  async stopAll() {
    this.stopManual();
    if (game.user.isGM && this.playlist) {
      for (const s of [...this.#livePlaylistSounds()]) await this.#stopSound(s, true);
    }
  }
}
