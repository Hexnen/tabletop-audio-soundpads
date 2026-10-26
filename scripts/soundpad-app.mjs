import { MODULE_ID, TAS, emit, SOUNDSCAPE_PAD } from "./module.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SoundPadApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** Per-layer desired volume (0..1), keyed by layerId, for the current pad. */
  #volumes = new Map();
  /** Per-layer auto-repeat interval in seconds (0 = off), keyed by layerId. */
  #repeats = new Map();
  /** Per-layer loop-mode override (bool), keyed by layerId; default = layer.loop. */
  #loops = new Map();
  #filter = "all";
  #padId = null;
  /** "pads" = cover-art picker, "pad" = the selected pad's board. */
  #view = "pads";
  /** Within the picker: "pads" or "soundscapes". */
  #browseTab = "pads";
  /** Soundscape genre filter. */
  #ssGenre = "all";
  /** Soundscape search text (title/flavor). */
  #ssSearch = "";
  /** Soundscape playback toggles (like Tabletop Audio's Loop + XFADE). */
  #ssLoop = true;
  #ssFade = true;
  /** Collapsible genre-filter drawer. */
  #ssFiltersOpen = false;
  /** Right "now playing" drawer. */
  #nowPlayingOpen = false;
  /** Playback-progress animation. */
  #progressTimer = null;
  #litProgress = new Set();
  #litWait = new Set();
  /** Remembered scroll offset so a re-render doesn't jump to the top. */
  #scroll = 0;
  /** Pad ids whose audio has been preloaded (so plays are instant). */
  #preloaded = new Set();

  // Tabletop Audio's standard "Every N" choices (seconds).
  static REPEAT_OPTIONS = [0, 10, 15, 30, 60, 120, 180, 300, 900, 1800];

  static DEFAULT_OPTIONS = {
    id: "tas-soundpad",
    classes: ["tabletop-audio-soundpads", "tas-app"],
    tag: "div",
    window: {
      title: "TAS.Title",
      icon: "fa-solid fa-record-vinyl",
      resizable: true
    },
    position: { width: 760, height: 640 },
    actions: {
      browse: SoundPadApp.#onBrowse,
      switchTab: SoundPadApp.#onSwitchTab,
      ssFilter: SoundPadApp.#onSsFilter,
      ssLoop: SoundPadApp.#onSsLoop,
      ssFade: SoundPadApp.#onSsFade,
      toggleSsFilters: SoundPadApp.#onToggleSsFilters,
      toggleNowPlaying: SoundPadApp.#onToggleNowPlaying,
      stopItem: SoundPadApp.#onStopItem,
      loopItem: SoundPadApp.#onLoopItem,
      goToItem: SoundPadApp.#onGoToItem,
      playSoundscape: SoundPadApp.#onPlaySoundscape,
      openPad: SoundPadApp.#onOpenPad,
      filterCat: SoundPadApp.#onFilter,
      tile: SoundPadApp.#onTile,
      loopToggle: SoundPadApp.#onLoopToggle,
      stopAll: SoundPadApp.#onStopAll,
      toggleBroadcast: SoundPadApp.#onToggleBroadcast
    }
  };

  // NB: literal path, not `${MODULE_ID}` — this static initializer runs while
  // module.mjs is still mid-import, so MODULE_ID would be in its TDZ here.
  static PARTS = {
    main: { template: "modules/tabletop-audio-soundpads/templates/soundpad.hbs" }
  };

  /** Singleton open/focus helper. */
  static open() {
    const existing = Object.values(ui.windows).find((w) => w instanceof SoundPadApp);
    if (existing) return existing.bringToFront?.() ?? existing.render({ force: true });
    return new SoundPadApp().render({ force: true });
  }

  get padId() {
    if (this.#padId) return this.#padId;
    const last = game.settings.get(MODULE_ID, "lastPad");
    if (last && TAS.index.some((p) => p.id === last)) return last;
    return TAS.index[0]?.id ?? null;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const padId = this.padId;
    const pad = padId ? await TAS.getPad(padId).catch(() => null) : null;

    const entry = TAS.index.find((p) => p.id === padId);
    context.isGM = game.user.isGM;
    context.broadcasting = TAS.canBroadcast();
    context.notDownloaded = TAS.preferLocal() && entry && entry.downloaded === false;
    context.padId = padId;
    context.browse = this.#view === "pads" || !pad;
    context.pads = TAS.index.map((p) => ({ ...p, selected: p.id === padId }));
    context.pad = pad;
    context.filter = this.#filter;

    // "Now playing" is module-wide — show it regardless of the current view.
    context.nowPlaying = this.#buildNowPlaying();
    context.npCount = context.nowPlaying.length;
    context.nowPlayingOpen = this.#nowPlayingOpen;

    if (context.browse) {
      context.tabPads = this.#browseTab === "pads";
      context.tabSS = this.#browseTab === "soundscapes";
      if (context.tabSS) this.#prepareSoundscapes(context);
    }

    if (!context.browse && pad) {
      context.categories = ["all", ...pad.categories].map((c) => ({
        key: c,
        active: c === this.#filter,
        label: game.i18n.localize(`TAS.Cat.${c}`)
      }));
      context.repeatOptions = SoundPadApp.REPEAT_OPTIONS.map((sec) => ({
        sec,
        label: this.#repeatLabel(sec)
      }));
      context.tiles = pad.layers.map((l) => {
        const looped = this.#loops.get(l.id) ?? l.loop;
        const active = TAS.engine.isActive(padId, l.id);
        // Sliders work in Foundry's perceptual "input" space so they read the
        // same as the native "currently playing" sliders. While playing, reflect
        // the live (document-synced) value; otherwise the desired/default.
        const liveVol = active ? TAS.engine.getVolume(padId, l.id) : null;
        const vol = liveVol ?? this.#volumes.get(l.id) ?? this.#toInput(l.gain ?? 0.5);
        return {
          ...l,
          active,
          looped,
          // Stop when playing a loop, play-loop when armed, bolt for one-shot.
          stateIcon: active ? "fa-circle-stop" : looped ? "fa-circle-play" : "fa-bolt",
          volume: vol,
          pct: Math.round(vol * 100),
          shown: this.#filter === "all" || l.category === this.#filter,
          // Auto-repeat (TTA's "Every N") only applies when not looping; the
          // loop button takes precedence, exactly like Tabletop Audio.
          repeatable: !looped,
          repeatSec: this.#repeats.get(l.id) ?? l.repeatDefault ?? 0
        };
      });
    } else {
      context.categories = [];
      context.tiles = [];
    }
    return context;
  }

  #prepareSoundscapes(context) {
    const cat = TAS.soundscapes ?? { genres: [], tracks: [] };
    context.ssGenres = ["all", ...cat.genres].map((g) => ({
      key: g,
      active: g === this.#ssGenre
    }));
    // Genre filters in the context (re-render); free-text search filters the
    // rendered cards live in the DOM (#applySsSearch), so they stay in the DOM.
    const tracks =
      this.#ssGenre === "all"
        ? cat.tracks
        : cat.tracks.filter((t) => t.genres.includes(this.#ssGenre));
    context.soundscapes = tracks.map((t) => ({
      ...t,
      tip: t.flavor || t.title,
      search: `${t.title} ${t.flavor ?? ""}`,
      active: TAS.engine.isActive(SOUNDSCAPE_PAD, `ss_${t.num}`)
    }));
    context.ssLoop = this.#ssLoop;
    context.ssFade = this.#ssFade;
    context.ssSearch = this.#ssSearch;
    context.ssFiltersOpen = this.#ssFiltersOpen;
    context.ssActiveGenre = this.#ssGenre;
    context.ssCount = tracks.length;
    context.ssTotal = cat.tracks.length;
    // Hint to download audio when the visible set has undownloaded tracks.
    context.ssNeedsDownload =
      TAS.preferLocal() && tracks.some((t) => t.downloaded === false);
    context.ssDownloadArg = this.#ssGenre === "all" ? "all" : this.#ssGenre;
  }

  _preRender(context, options) {
    super._preRender?.(context, options);
    const grid = this.element?.querySelector(".tas-grid, .tas-pad-grid");
    this.#scroll = grid ? grid.scrollTop : 0;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    // Restore scroll so clicking a tile doesn't jump the list to the top.
    const grid = this.element.querySelector(".tas-grid, .tas-pad-grid");
    if (grid && this.#scroll) grid.scrollTop = this.#scroll;
    // Volume sliders aren't action-based; wire them here.
    for (const slider of this.element.querySelectorAll("input.tas-vol")) {
      slider.addEventListener("input", this.#onVolume.bind(this));
    }
    // Hide images that fail to load (e.g. not downloaded yet) so we don't show
    // broken-image placeholders.
    for (const img of this.element.querySelectorAll("img.tas-icon, img.tas-cover, img.tas-pad-header")) {
      img.addEventListener("error", () => img.classList.add("tas-hidden"));
    }
    // Repeat-interval dropdowns: set current value (TTA default unless changed)
    // + wire change handler.
    for (const sel of this.element.querySelectorAll("select.tas-repeat")) {
      sel.value = String(this.#repeats.get(sel.dataset.layerId) ?? sel.dataset.current ?? 0);
      sel.addEventListener("change", this.#onRepeat.bind(this));
    }
    // Soundscape search — filter cards live, without a re-render (keeps focus).
    const search = this.element.querySelector("input.tas-search");
    if (search) {
      search.addEventListener("input", (ev) => {
        this.#ssSearch = ev.currentTarget.value;
        this.#applySsSearch();
      });
      this.#applySsSearch(); // re-apply after a (genre) re-render
    }

    // Decode this pad's audio up front so the first click on any tile is
    // instant (otherwise the first play stalls while the file is decoded).
    if (context.pad && !this.#preloaded.has(context.padId)) {
      this.#preloaded.add(context.padId);
      this.#preloadPad(context.pad);
    }

    // Set progress bars to their CURRENT values immediately (no animation), so a
    // re-render doesn't make them sweep up from zero, then keep animating.
    this.#tickProgress(true);
    this.#startProgress();
  }

  #preloadPad(pad) {
    const preferLocal = TAS.preferLocal();
    for (const layer of pad.layers ?? []) {
      try {
        const src = TAS.engine.resolveSrc(layer, { preferLocal });
        // Creating + loading caches the decoded buffer Foundry reuses on play.
        game.audio.create({ src, singleInstance: true }).load().catch(() => {});
      } catch {}
    }
  }

  #applySsSearch() {
    const q = this.#ssSearch.trim().toLowerCase();
    for (const card of this.element.querySelectorAll(".tas-ss-card")) {
      const hay = (card.dataset.search || "").toLowerCase();
      card.style.display = !q || hay.includes(q) ? "" : "none";
    }
  }

  _onClose(options) {
    super._onClose(options);
    this.#stopProgress();
  }

  #startProgress() {
    if (this.#progressTimer) return;
    this.#progressTimer = window.setInterval(() => this.#tickProgress(), 100);
  }
  #stopProgress() {
    if (this.#progressTimer) window.clearInterval(this.#progressTimer);
    this.#progressTimer = null;
    this.#litProgress.clear();
    this.#litWait.clear();
  }

  #barFor(padId, layerId, sel) {
    if (padId === SOUNDSCAPE_PAD) {
      const num = layerId.replace("ss_", "");
      return this.element.querySelector(`.tas-ss-card[data-num="${num}"] ${sel}`);
    }
    if (padId === this.padId) {
      return this.element.querySelector(`.tas-tile[data-layer-id="${layerId}"] ${sel}`);
    }
    return null;
  }

  #updateBars(entries, sel, lit, snap) {
    const seen = new Set();
    for (const p of entries) {
      const bar = this.#barFor(p.padId, p.layerId, sel);
      if (!bar) continue;
      // `snap`: jump straight to the value (no transition) — used right after a
      // re-render so bars don't animate up from 0 (the "catch-up" flicker).
      if (snap) {
        bar.style.transition = "none";
        bar.style.width = `${Math.round(p.progress * 100)}%`;
        void bar.offsetWidth; // force reflow, then restore the transition
        bar.style.transition = "";
      } else {
        bar.style.width = `${Math.round(p.progress * 100)}%`;
      }
      seen.add(bar);
      lit.add(bar);
    }
    for (const bar of lit) {
      if (!seen.has(bar)) {
        bar.style.width = "0%";
        lit.delete(bar);
      }
    }
  }

  #tickProgress(snap) {
    if (!this.element?.isConnected) return this.#stopProgress();
    // Bottom edge: playback position. Top edge: countdown to the next repeat.
    this.#updateBars(TAS.engine.getPlaybacks(), ".tas-progress", this.#litProgress, snap);
    this.#updateBars(TAS.engine.getRepeats(), ".tas-progress-top", this.#litWait, snap);
  }

  /** Convert a raw gain to Foundry's perceptual slider "input" value. */
  #toInput(gain) {
    return foundry.audio.AudioHelper.volumeToInput(gain);
  }

  /** Raw gain for manual sounds (one-shots/repeats), from the slider or default. */
  #gainFor(layerId, fallbackGain) {
    const input = this.#volumes.get(layerId);
    return input != null ? foundry.audio.AudioHelper.inputToVolume(input) : (fallbackGain ?? 0.7);
  }

  #repeatLabel(sec) {
    if (!sec) return game.i18n.localize("TAS.Repeat.None");
    if (sec < 60) return game.i18n.format("TAS.Repeat.Sec", { n: sec });
    return game.i18n.format("TAS.Repeat.Min", { n: sec / 60 });
  }

  /** Everything currently sounding across the whole module, for the right drawer. */
  #buildNowPlaying() {
    const state = TAS.engine.getState();
    const sourceName = (padId) =>
      padId === SOUNDSCAPE_PAD
        ? game.i18n.localize("TAS.Tab.Soundscapes")
        : TAS.index.find((p) => p.id === padId)?.name ?? padId;
    const items = [];
    for (const e of state.layers ?? []) {
      items.push({
        key: e.key,
        padId: e.padId,
        layerId: e.layerId,
        label: e.label,
        source: sourceName(e.padId),
        soundscape: e.padId === SOUNDSCAPE_PAD,
        looping: e.loop !== false,
        canLoop: !e.oneshot, // transient one-shots get no loop toggle
        kind: e.oneshot ? "oneshot" : "loop"
      });
    }
    for (const r of state.repeats ?? []) {
      items.push({
        key: r.key,
        padId: r.padId,
        layerId: r.layerId,
        label: r.label,
        source: sourceName(r.padId),
        badge: this.#repeatLabel(r.interval),
        kind: "repeat"
      });
    }
    return items;
  }

  // --- actions --------------------------------------------------------------

  static #onBrowse() {
    this.#view = "pads";
    this.render();
  }

  static #onSwitchTab(event, target) {
    this.#browseTab = target.dataset.tab;
    this.render();
  }

  static #onSsFilter(event, target) {
    this.#ssGenre = target.dataset.genre;
    this.#ssFiltersOpen = false;
    this.render();
  }

  static #onToggleSsFilters() {
    this.#ssFiltersOpen = !this.#ssFiltersOpen;
    this.render();
  }

  static #onToggleNowPlaying() {
    this.#nowPlayingOpen = !this.#nowPlayingOpen;
    this.render();
  }

  static async #onStopItem(event, target) {
    const { key, padId, layerId } = target.dataset;
    await TAS.engine.stopByKey(key); // exact doc (loop or one-shot); no-op for repeaters
    TAS.engine.clearRepeat(padId, layerId);
    this.#repeats.delete(layerId);
    if (TAS.canBroadcast()) emit({ action: "clearRepeat", padId, layerId });
    this.render();
  }

  static async #onLoopItem(event, target) {
    const { padId, layerId } = target.dataset;
    const loop = !TAS.engine.isLooping(padId, layerId);
    await TAS.engine.setItemLoop(padId, layerId, loop); // syncs via document
    this.render();
  }

  static async #onGoToItem(event, target) {
    const { padId } = target.dataset;
    if (padId === SOUNDSCAPE_PAD) {
      this.#view = "pads";
      this.#browseTab = "soundscapes";
    } else {
      this.#padId = padId;
      this.#view = "pad";
      this.#filter = "all";
    }
    this.render();
  }

  static #onSsLoop() {
    this.#ssLoop = !this.#ssLoop;
    this.render();
  }

  static #onSsFade() {
    this.#ssFade = !this.#ssFade;
    this.render();
  }

  static async #onPlaySoundscape(event, target) {
    await TAS.engine.ensureAudioReady(); // unlock the audio context (in-gesture)
    const num = Number(target.dataset.num);
    const track = TAS.soundscapes?.tracks.find((t) => t.num === num);
    if (!track) return;
    const layer = TAS.soundscapeLayer(track);
    const preferLocal = TAS.preferLocal();
    await TAS.engine.toggleLoop(SOUNDSCAPE_PAD, layer, {
      preferLocal, loop: this.#ssLoop, fade: this.#ssFade // engine defaults volume from gain
    });
    this.render();
  }

  static async #onOpenPad(event, target) {
    this.#padId = target.dataset.padId;
    this.#view = "pad";
    this.#filter = "all";
    await game.settings.set(MODULE_ID, "lastPad", this.#padId);
    this.render();
  }

  static #onFilter(event, target) {
    this.#filter = target.dataset.cat;
    this.render();
  }

  static async #onTile(event, target) {
    await TAS.engine.ensureAudioReady(); // unlock the audio context (in-gesture)
    const layerId = target.dataset.layerId;
    const pad = await TAS.getPad(this.padId);
    const layer = pad.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const preferLocal = TAS.preferLocal();
    const looped = this.#loops.get(layerId) ?? layer.loop;

    // Loop mode → toggle a continuous loop; otherwise fire a single one-shot.
    // One-shots use a manual Sound (no document) so they play INSTANTLY — the
    // PlaylistSound round-trip per click was too slow for SFX. Mirrored to
    // players over the socket.
    if (!looped) {
      const volume = this.#gainFor(layerId, layer.gain);
      await TAS.engine.playOneShot(this.padId, layer, { volume, preferLocal });
      if (TAS.canBroadcast()) emit({ action: "oneshot", padId: this.padId, layerId, layer, volume });
      target.classList.add("tas-flash");
      window.setTimeout(() => target.classList.remove("tas-flash"), 350);
      return;
    }

    // Looping layers are PlaylistSound documents — Foundry syncs them to every
    // client natively (volume passed in input space; engine defaults from gain).
    await TAS.engine.toggleLoop(this.padId, layer, {
      volume: this.#volumes.get(layerId), preferLocal, loop: true
    });
    this.render();
  }

  static async #onLoopToggle(event, target) {
    const layerId = target.dataset.layerId;
    const pad = await TAS.getPad(this.padId);
    const layer = pad.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const looped = !(this.#loops.get(layerId) ?? layer.loop);
    this.#loops.set(layerId, looped);

    // Turning loop off while it's looping stops it (TTA: "...unless you uncheck").
    if (!looped && TAS.engine.isActive(this.padId, layerId)) {
      await TAS.engine.stopLayer(this.padId, layerId);
    }
    this.render();
  }

  static async #onStopAll() {
    await TAS.engine.stopAll(); // loops stop via native sync
    if (TAS.canBroadcast()) emit({ action: "stopManual" });
    this.render();
  }

  static async #onToggleBroadcast() {
    await game.settings.set(MODULE_ID, "broadcast", !game.settings.get(MODULE_ID, "broadcast"));
    this.render();
  }

  #onVolume(event) {
    const slider = event.currentTarget;
    const layerId = slider.dataset.layerId;
    const volume = Number(slider.value) / 100;
    this.#volumes.set(layerId, volume);
    const pctEl = slider.closest(".tas-tile")?.querySelector(".tas-pct");
    if (pctEl) pctEl.textContent = `${Math.round(volume * 100)}%`;
    if (TAS.engine.isActive(this.padId, layerId)) {
      TAS.engine.setVolume(this.padId, layerId, volume); // syncs via document
    }
  }

  async #onRepeat(event) {
    const sel = event.currentTarget;
    const layerId = sel.dataset.layerId;
    const interval = Number(sel.value);
    const pad = await TAS.getPad(this.padId);
    const layer = pad.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const volume = this.#gainFor(layerId, layer.gain); // repeater fires manual one-shots (raw gain)
    const preferLocal = TAS.preferLocal();

    if (interval > 0) this.#repeats.set(layerId, interval);
    else this.#repeats.delete(layerId);

    TAS.engine.setRepeat(this.padId, layer, interval, { volume, preferLocal });
    if (TAS.canBroadcast()) {
      if (interval > 0) emit({ action: "repeat", padId: this.padId, layerId, layer, interval, volume });
      else emit({ action: "clearRepeat", padId: this.padId, layerId });
    }
    // Reflect the on/off state visually.
    sel.closest(".tas-tile")?.classList.toggle("repeating", interval > 0);
  }
}
