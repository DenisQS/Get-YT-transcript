// Runs inside the YouTube page so it can read the video player.
// The button (content.js) asks for a transcript with window.postMessage.
(function () {
  if (globalThis.__ytCopyTranscriptBridge) return;
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

  function preferredLanguages() {
    const langs = [];
    if (document.documentElement.lang) langs.push(document.documentElement.lang);
    try {
      const hl = globalThis.ytcfg && ytcfg.get && ytcfg.get("HL");
      if (hl) langs.push(hl);
    } catch (error) {
      // ignore
    }
    if (navigator.language) langs.push(navigator.language);
    langs.push("en");
    return langs;
  }

  function listTracks(response) {
    const renderer = response && response.captions && response.captions.playerCaptionsTracklistRenderer;
    const tracks = renderer && renderer.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
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
    if (responseId === videoId) raw.push.apply(raw, listTracks(response));
    // Audio-track caption URLs are live player state. Ignore them until the
    // player reports this video, or a previous video's tracks could leak through.
    if (dataId === videoId) raw.push.apply(raw, audioTracks);
    if (initialId === videoId) raw.push.apply(raw, listTracks(initial));

    const lib = globalThis.__ytCopyTranscriptLib;
    const tracks = lib ? lib.normalizeTracks(raw) : [];
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
      tracks: tracks,
      title: title,
      status: status,
    };
  }

  // The player fills in caption URLs shortly after the video loads. Some of
  // those URLs include a pot token that timedtext refuses to answer without.
  // On a normal click the token is already there. If a fetch comes back empty,
  // call again with wantPot and wait a little longer for the player to add it.
  async function waitForSnapshot(videoId, options) {
    const wantPot = Boolean(options && options.wantPot);
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

  async function loadLines(tracks) {
    const lib = globalThis.__ytCopyTranscriptLib;
    const preferred = preferredLanguages();
    const best = lib.chooseTrack(tracks, preferred);
    if (!best) return [];
    let lines = await fetchTrack(best);
    if (lines && lines.length) return lines;
    const withPot = lib.chooseTrack(
      tracks.filter(function (track) { return track.hasPot; }),
      preferred
    );
    if (withPot && withPot.baseUrl !== best.baseUrl) {
      const potLines = await fetchTrack(withPot);
      if (potLines && potLines.length) return potLines;
      if (potLines) return potLines;
    }
    return lines;
  }

  async function buildTranscript(videoId) {
    const lib = globalThis.__ytCopyTranscriptLib;
    if (!lib) return { ok: false, error: "fetch-failed" };

    let snap = await waitForSnapshot(videoId);
    if (!snap || currentVideoId() !== videoId) return { ok: false, error: "fetch-failed" };
    if (!snap.tracks.length) {
      return { ok: false, error: snap.status === "OK" ? "no-captions" : "fetch-failed" };
    }

    let lines = await loadLines(snap.tracks);
    const hadPot = snap.tracks.some(function (track) { return track.hasPot; });
    if ((!lines || !lines.length) && !hadPot && currentVideoId() === videoId) {
      const later = await waitForSnapshot(videoId, { wantPot: true });
      if (later && later.tracks.some(function (track) { return track.hasPot; })) {
        lines = await loadLines(later.tracks);
        if (later.title) snap = later;
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
    };
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== "request") return;
    const requestId = data.requestId;
    const videoId = data.videoId;
    buildTranscript(videoId).then(function (payload) {
      window.postMessage(
        { source: SOURCE, type: "response", requestId: requestId, payload: payload },
        location.origin
      );
    }).catch(function () {
      window.postMessage(
        {
          source: SOURCE,
          type: "response",
          requestId: requestId,
          payload: { ok: false, error: "fetch-failed" },
        },
        location.origin
      );
    });
  });
})();
