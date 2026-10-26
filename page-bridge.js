// Runs inside the YouTube page so it can read the video player.
// The button (content.js) asks for a transcript with window.postMessage.
(function () {
  if (globalThis.__ytCopyTranscriptBridge) {
    // The watch page can rebuild <html> without running this script again.
    if (document.documentElement) document.documentElement.dataset.ytCopyTranscriptBridge = "1";
    return;
  }
  globalThis.__ytCopyTranscriptBridge = true;

  const SOURCE = "yt-copy-transcript";

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function currentVideoId() {
    return new URLSearchParams(location.search).get("v");
  }

  function clientName() {
    try {
      const name = globalThis.ytcfg && ytcfg.get && ytcfg.get("INNERTUBE_CLIENT_NAME");
      if (typeof name === "string" && name) return name;
    } catch (error) {
      // ytcfg is not ready yet.
    }
    return "WEB";
  }

  function captionTracksFrom(response) {
    const renderer = response && response.captions && response.captions.playerCaptionsTracklistRenderer;
    const tracks = renderer && renderer.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  }

  function translationLanguagesFrom(response) {
    const renderer = response && response.captions && response.captions.playerCaptionsTracklistRenderer;
    const list = renderer && renderer.translationLanguages;
    return Array.isArray(list) ? list : [];
  }

  function rememberedFromMessage(value) {
    if (!value || typeof value.languageCode !== "string") return null;
    const languageCode = value.languageCode.trim();
    if (!languageCode || languageCode.length > 32) return null;
    const kind = value.kind === "asr" || value.kind === "translation" ? value.kind : "";
    return { languageCode: languageCode, kind: kind };
  }

  function trackKeyFromMessage(value) {
    if (typeof value !== "string" || !value || value.length > 200) return "";
    return value;
  }

  function snapshotPlayer(videoId) {
    const player = document.getElementById("movie_player");
    let videoData = null;
    let response = null;
    let audioTracks = [];
    try {
      videoData = player && player.getVideoData ? player.getVideoData() : null;
    } catch (error) {
      videoData = null;
    }
    try {
      response = player && player.getPlayerResponse ? player.getPlayerResponse() : null;
    } catch (error) {
      response = null;
    }
    try {
      const audio = player && player.getAudioTrack ? player.getAudioTrack() : null;
      audioTracks = audio && Array.isArray(audio.captionTracks) ? audio.captionTracks : [];
    } catch (error) {
      audioTracks = [];
    }

    const initial = globalThis.ytInitialPlayerResponse || null;
    const responseId = response && response.videoDetails && response.videoDetails.videoId;
    const dataId = videoData && videoData.video_id;
    const initialId = initial && initial.videoDetails && initial.videoDetails.videoId;

    const raw = [];
    const matched = [];
    if (responseId === videoId && response) {
      raw.push.apply(raw, captionTracksFrom(response));
      matched.push(response);
    }
    // Audio-track caption URLs are live player state. Ignore them until the
    // player reports this video, or a previous video's tracks could leak through.
    if (dataId === videoId) raw.push.apply(raw, audioTracks);
    if (initialId === videoId && initial) {
      raw.push.apply(raw, captionTracksFrom(initial));
      matched.push(initial);
    }

    const lib = globalThis.__ytCopyTranscriptLib;
    const tracks = lib ? lib.normalizeTracks(raw) : [];
    let translationLanguages = [];
    let originalLanguage = "";
    if (lib) {
      for (let i = 0; i < matched.length && !translationLanguages.length; i++) {
        translationLanguages = lib.normalizeTranslationLanguages(translationLanguagesFrom(matched[i]));
      }
      let audioList = [];
      if (dataId === videoId) {
        try {
          audioList = player && player.getAvailableAudioTracks ? player.getAvailableAudioTracks() || [] : [];
        } catch (error) {
          audioList = [];
        }
      }
      originalLanguage = lib.originalLanguageFromAudioList(Array.isArray(audioList) ? audioList : []);
      if (!originalLanguage) {
        const formats = [];
        matched.forEach(function (item) {
          const list = item.streamingData && item.streamingData.adaptiveFormats;
          if (Array.isArray(list)) formats.push.apply(formats, list);
        });
        originalLanguage = lib.originalLanguageFromFormats(formats);
      }
    }
    const ready = responseId === videoId || dataId === videoId || initialId === videoId;
    let title = "";
    if (dataId === videoId && videoData && videoData.title) title = videoData.title;
    else if (responseId === videoId && response.videoDetails && response.videoDetails.title) {
      title = response.videoDetails.title;
    } else if (initialId === videoId && initial.videoDetails && initial.videoDetails.title) {
      title = initial.videoDetails.title;
    }

    const status = responseId === videoId && response.playabilityStatus
      ? response.playabilityStatus.status
      : null;

    return {
      ready: ready,
      // Caption names and translation languages live on the player response.
      // Audio-track URLs can arrive first and are not the full list.
      captionsReady: responseId === videoId || initialId === videoId,
      tracks: tracks,
      title: title,
      status: status,
      translationLanguages: translationLanguages,
      originalLanguage: originalLanguage,
    };
  }

  // The player fills in caption URLs shortly after the video loads. Some of
  // those URLs include a pot token that timedtext refuses to answer without.
  // On a normal click the token is already there. If a fetch comes back empty,
  // call again with wantPot and wait a little longer for the player to add it.
  // Listing languages does not need the token, so that can return sooner.
  async function waitForSnapshot(videoId, options) {
    const wantPot = Boolean(options && options.wantPot);
    const listOnly = Boolean(options && options.listOnly);
    const timeout = wantPot ? 4000 : 2500;
    const started = Date.now();
    let best = null;
    while (Date.now() - started < timeout) {
      if (currentVideoId() !== videoId) return null;
      const snap = snapshotPlayer(videoId);
      if (snap.ready) {
        best = snap;
        if (snap.tracks.some(function (track) { return track.hasPot; })) return snap;
        const waited = Date.now() - started;
        if (listOnly && snap.captionsReady && (snap.tracks.length || snap.status === "OK")) return snap;
        if (!wantPot && snap.tracks.length && waited > 700) return snap;
        if (!wantPot && !snap.tracks.length && snap.status === "OK" && waited > 1500) return snap;
      }
      await delay(200);
    }
    return best;
  }

  function readTitle(snap) {
    if (snap && snap.title) return snap.title;
    const heading = document.querySelector("ytd-watch-metadata h1");
    const text = heading && heading.textContent ? heading.textContent.trim() : "";
    if (text) return text;
    return document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
  }

  async function fetchBody(url) {
    const lib = globalThis.__ytCopyTranscriptLib;
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) return null;
      const body = await response.text();
      if (!body.trim()) return null;
      const parsed = lib.parseTimedText(body);
      if (!parsed || parsed.invalid) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  async function fetchTrack(track) {
    const lib = globalThis.__ytCopyTranscriptLib;
    const client = clientName();
    const jsonResult = await fetchBody(lib.timedTextUrl(track.baseUrl, client, "json3"));
    if (jsonResult && jsonResult.lines && jsonResult.lines.length) return jsonResult.lines;
    const xmlResult = await fetchBody(lib.timedTextUrl(track.baseUrl, client, "srv3"));
    if (xmlResult && xmlResult.lines && xmlResult.lines.length) return xmlResult.lines;
    if ((jsonResult && jsonResult.lines) || (xmlResult && xmlResult.lines)) return [];
    return null;
  }

  function builtFrom(snap) {
    const lib = globalThis.__ytCopyTranscriptLib;
    return lib.buildTrackList(snap.tracks, snap.translationLanguages, snap.originalLanguage);
  }

  function emptySnapshotResult(snap) {
    if (!snap) return { ok: false, error: "fetch-failed" };
    if (!snap.tracks.length) {
      return { ok: false, error: snap.status === "OK" ? "no-captions" : "fetch-failed" };
    }
    return null;
  }

  async function listCaptionTracks(videoId, remembered) {
    const lib = globalThis.__ytCopyTranscriptLib;
    if (!lib) return { ok: false, error: "fetch-failed" };
    const snap = await waitForSnapshot(videoId, { listOnly: true });
    if (!snap || currentVideoId() !== videoId) return { ok: false, error: "fetch-failed" };
    const empty = emptySnapshotResult(snap);
    if (empty) return empty;
    const built = builtFrom(snap);
    const selected = lib.resolveTrack(built.tracks, "", remembered, built.originalLanguage);
    return {
      ok: true,
      tracks: lib.publicTracks(built.tracks),
      selectedKey: selected ? selected.key : "",
    };
  }

  async function buildTranscript(videoId, trackKey, remembered) {
    const lib = globalThis.__ytCopyTranscriptLib;
    if (!lib) return { ok: false, error: "fetch-failed" };

    let snap = await waitForSnapshot(videoId);
    if (!snap || currentVideoId() !== videoId) return { ok: false, error: "fetch-failed" };
    const empty = emptySnapshotResult(snap);
    if (empty) return empty;

    let built = builtFrom(snap);
    let chosen = lib.resolveTrack(built.tracks, trackKey, remembered, built.originalLanguage);
    if (!chosen) return { ok: false, error: "fetch-failed" };

    let lines = await fetchTrack(chosen);
    // Retry the same language once the player adds a pot token. Do not switch
    // to a different caption track just because that one has a token.
    if ((!lines || !lines.length) && !chosen.hasPot && currentVideoId() === videoId) {
      const later = await waitForSnapshot(videoId, { wantPot: true });
      if (later && currentVideoId() === videoId) {
        const rebuilt = lib.buildTrackList(
          later.tracks,
          later.translationLanguages,
          later.originalLanguage || snap.originalLanguage
        );
        const again = lib.resolveTrack(rebuilt.tracks, chosen.key, null, rebuilt.originalLanguage);
        if (again && again.hasPot) {
          const potLines = await fetchTrack(again);
          if (potLines && potLines.length) {
            lines = potLines;
            chosen = again;
            if (later.title) snap = later;
          } else if (potLines) {
            lines = potLines;
          }
        }
      }
    }

    if (currentVideoId() !== videoId) return { ok: false, error: "fetch-failed" };
    if (!lines) return { ok: false, error: "fetch-failed" };
    if (!lines.length) return { ok: false, error: "no-captions" };
    return {
      ok: true,
      text: lib.formatTranscript({
        title: readTitle(snap),
        url: "https://www.youtube.com/watch?v=" + videoId,
        lines: lines,
      }),
      track: lib.publicTracks([chosen])[0],
    };
  }

  function reply(requestId, payload) {
    window.postMessage(
      { source: SOURCE, type: "response", requestId: requestId, payload: payload },
      location.origin
    );
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type !== "request" && data.type !== "list-tracks") return;
    const requestId = data.requestId;
    const videoId = typeof data.videoId === "string" ? data.videoId : "";
    const remembered = rememberedFromMessage(data.remembered);
    const pending = data.type === "list-tracks"
      ? listCaptionTracks(videoId, remembered)
      : buildTranscript(videoId, trackKeyFromMessage(data.trackKey), remembered);
    pending.then(function (payload) {
      reply(requestId, payload);
    }).catch(function () {
      reply(requestId, { ok: false, error: "fetch-failed" });
    });
  });

  // The button lives in another script world and cannot see this function.
  // A DOM flag is how it knows the listener is attached before it asks.
  if (document.documentElement) document.documentElement.dataset.ytCopyTranscriptBridge = "1";
})();
