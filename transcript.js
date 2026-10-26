// Turns YouTube caption data into plain text with timestamps.
// This file does not touch the page. The page bridge calls it.
(function () {
  function isAuto(track) {
    if (!track) return false;
    if (track.kind === "asr") return true;
    return typeof track.vssId === "string" && track.vssId.startsWith("a.");
  }

  function trackKey(track) {
    return [track.languageCode || "", track.kind || "", track.vssId || ""].join("|");
  }

  function readText(node) {
    if (!node) return "";
    if (typeof node === "string") return node.trim();
    if (typeof node.simpleText === "string" && node.simpleText.trim()) return node.simpleText.trim();
    if (Array.isArray(node.runs)) {
      const text = node.runs.map(function (run) {
        return run && run.text ? run.text : "";
      }).join("").trim();
      if (text) return text;
    }
    const label = node.accessibility && node.accessibility.accessibilityData && node.accessibility.accessibilityData.label;
    return typeof label === "string" ? label.trim() : "";
  }

  function baseLanguage(code) {
    return String(code || "").toLowerCase().split("-")[0].split("_")[0];
  }

  // "en" matches "en-US". "en-US" does not match "en-GB": those are different tracks.
  function sameLanguage(a, b) {
    const left = String(a || "").toLowerCase().replace(/_/g, "-");
    const right = String(b || "").toLowerCase().replace(/_/g, "-");
    if (!left || !right) return false;
    if (left === right) return true;
    const leftBase = left.split("-")[0];
    const rightBase = right.split("-")[0];
    if (leftBase !== rightBase) return false;
    return left === leftBase || right === rightBase;
  }

  function urlHasPot(baseUrl) {
    try {
      return new URL(String(baseUrl), "https://www.youtube.com").searchParams.has("pot");
    } catch (error) {
      return false;
    }
  }

  // Keep one entry per track. If the player later adds a proof-of-origin
  // token (pot) to the same track, keep that URL — timedtext needs it.
  function normalizeTracks(rawTracks) {
    const map = new Map();
    (rawTracks || []).forEach(function (track, index) {
      if (!track) return;
      const languageCode = track.languageCode ? String(track.languageCode) : "";
      const baseUrl = track.url || track.baseUrl;
      if (!languageCode || !baseUrl) return;
      const vssId = track.vssId ? String(track.vssId) : "";
      const kind = isAuto(track) ? "asr" : "";
      const key = trackKey({ languageCode: languageCode, kind: kind, vssId: vssId });
      const hasPot = urlHasPot(baseUrl);
      const youtubeName = readText(track.name);
      const trackName = track.trackName ? String(track.trackName).trim() : "";
      const isTranslatable = track.isTranslatable === true;
      const existing = map.get(key);
      if (!existing || (hasPot && !existing.hasPot)) {
        map.set(key, {
          languageCode: languageCode,
          kind: kind,
          vssId: vssId,
          baseUrl: String(baseUrl),
          hasPot: hasPot,
          index: existing ? existing.index : index,
          youtubeName: youtubeName || (existing && existing.youtubeName) || "",
          trackName: trackName || (existing && existing.trackName) || "",
          isTranslatable: isTranslatable || Boolean(existing && existing.isTranslatable),
          isTranslation: false,
        });
        return;
      }
      if (youtubeName && !existing.youtubeName) existing.youtubeName = youtubeName;
      if (trackName && !existing.trackName) existing.trackName = trackName;
      if (isTranslatable) existing.isTranslatable = true;
    });
    return Array.from(map.values());
  }

  function normalizeTranslationLanguages(raw) {
    const out = [];
    const seen = new Set();
    (raw || []).forEach(function (lang) {
      if (!lang) return;
      const languageCode = lang.languageCode ? String(lang.languageCode) : "";
      if (!languageCode || seen.has(languageCode.toLowerCase())) return;
      seen.add(languageCode.toLowerCase());
      out.push({
        languageCode: languageCode,
        name: readText(lang.languageName || lang.name),
      });
    });
    return out;
  }

  function audioLabel(audio) {
    if (!audio) return "";
    const value = audio.displayName || audio.audioTrackDisplayName || audio.name || "";
    return readText(value);
  }

  // YouTube labels the spoken audio track with the word "original"
  // (also "Original" in several other interface languages).
  function originalCodeFromAudio(audio) {
    const label = audioLabel(audio);
    if (!label || !/\boriginal\b/i.test(label)) return "";
    const explicit = audio.languageCode ? String(audio.languageCode) : "";
    if (/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*$/.test(explicit)) return explicit;
    const id = String(audio.id || audio.audioTrackId || "");
    const match = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)/.exec(id);
    return match ? match[1] : "";
  }

  function originalLanguageFromFormats(formats) {
    let fallback = "";
    let preferred = "";
    (Array.isArray(formats) ? formats : []).forEach(function (format) {
      const audio = format && format.audioTrack;
      const code = originalCodeFromAudio(audio);
      if (!code) return;
      if (!fallback) fallback = code;
      if (audio.audioIsDefault && !preferred) preferred = code;
    });
    return preferred || fallback;
  }

  function originalLanguageFromAudioList(list) {
    let fallback = "";
    let preferred = "";
    (Array.isArray(list) ? list : []).forEach(function (audio) {
      const code = originalCodeFromAudio(audio);
      if (!code) return;
      if (!fallback) fallback = code;
      if ((audio.isDefault || audio.audioIsDefault) && !preferred) preferred = code;
    });
    return preferred || fallback;
  }

  // Auto-captions are generated in the language YouTube heard. That is the
  // spoken language when the audio track itself is not labeled.
  function inferOriginalLanguage(tracks) {
    const asr = (tracks || []).filter(function (track) {
      return track.kind === "asr" && !track.isTranslation;
    }).sort(function (a, b) {
      return a.index - b.index;
    });
    return asr.length ? asr[0].languageCode : "";
  }

  function fixLanguageCode(code) {
    const raw = String(code || "").trim().replace(/_/g, "-");
    if (!raw) return "";
    const parts = raw.split("-");
    const aliases = { iw: "he", in: "id", ji: "yi", jw: "jv", mo: "ro", sh: "sr" };
    const base = parts[0].toLowerCase();
    parts[0] = aliases[base] || base;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].length === 4) {
        parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].slice(1).toLowerCase();
      } else if (parts[i].length === 2 || parts[i].length === 3) {
        parts[i] = parts[i].toUpperCase();
      }
    }
    return parts.join("-");
  }

  function englishLanguageName(code) {
    const fixed = fixLanguageCode(code);
    if (!fixed) return "";
    try {
      const names = new Intl.DisplayNames(["en"], { type: "language" });
      const name = names.of(fixed);
      if (!name) return "";
      const folded = name.toLowerCase();
      if (folded === fixed.toLowerCase() || folded === String(code || "").toLowerCase()) return "";
      return name;
    } catch (error) {
      return "";
    }
  }

  function cleanYoutubeName(name) {
    return String(name || "")
      .replace(/\s*\([^)]*(?:auto[\s-]*generated|automatic(?:ally)?(?:\s+generated)?)[^)]*\)\s*$/i, "")
      .trim();
  }

  function extraTrackName(track, languageName) {
    const raw = String(track.trackName || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (lower === String(languageName || "").toLowerCase()) return "";
    if (lower === String(track.languageCode || "").toLowerCase()) return "";
    if (lower === String(track.youtubeName || "").toLowerCase()) return "";
    if (/auto[\s-]*generated|automatic/i.test(raw)) return "";
    return raw;
  }

  function baseLabel(track) {
    const intlName = englishLanguageName(track.languageCode);
    const fallback = cleanYoutubeName(track.youtubeName);
    let name = intlName || fallback || track.languageCode || "Unknown language";
    const extra = extraTrackName(track, name);
    if (extra) name = name + " — " + extra;
    if (track.kind === "asr") return name + " (auto-generated)";
    if (track.isTranslation || track.kind === "translation") return name + " (translated)";
    return name;
  }

  function assignLabels(tracks) {
    const bases = tracks.map(baseLabel);
    return bases.map(function (label, index) {
      let twins = 0;
      for (let i = 0; i < bases.length; i++) {
        if (bases[i] === label) twins++;
      }
      if (twins < 2) return label;
      const code = String(tracks[index].languageCode || "");
      const withCode = label + " (" + code + ")";
      let codeTwins = 0;
      for (let i = 0; i < bases.length; i++) {
        if (bases[i] === label && String(tracks[i].languageCode || "") === code) codeTwins++;
      }
      if (codeTwins < 2) return withCode;
      let n = 0;
      for (let i = 0; i <= index; i++) {
        if (bases[i] === label && String(tracks[i].languageCode || "") === code) n++;
      }
      return withCode + " (" + n + ")";
    });
  }

  function withTranslationUrl(baseUrl, languageCode) {
    const url = new URL(String(baseUrl), "https://www.youtube.com");
    url.searchParams.set("tlang", languageCode);
    return url.toString();
  }

  function translationSource(tracks, original) {
    const pool = tracks.filter(function (track) {
      return track.isTranslatable === true && track.baseUrl && !track.isTranslation;
    });
    if (!pool.length) return null;
    pool.sort(function (a, b) {
      const aOrig = original && sameLanguage(a.languageCode, original) ? 0 : 1;
      const bOrig = original && sameLanguage(b.languageCode, original) ? 0 : 1;
      if (aOrig !== bOrig) return aOrig - bOrig;
      const aManual = a.kind === "asr" ? 1 : 0;
      const bManual = b.kind === "asr" ? 1 : 0;
      if (aManual !== bManual) return aManual - bManual;
      return a.index - b.index;
    });
    return pool[0];
  }

  function languageCodeOk(code) {
    return /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/.test(code);
  }

  // Real caption tracks first (manual, then auto-generated), then YouTube's
  // translations of a translatable track. A translation is skipped when the
  // video already has captions in that language.
  function buildTrackList(realTracks, translationLanguages, originalHint) {
    const tracks = (realTracks || []).map(function (track) {
      return Object.assign({}, track, { isTranslation: false, kind: track.kind || "" });
    });
    const original = originalHint || inferOriginalLanguage(tracks);
    const source = translationSource(tracks, original);
    const seen = new Set(tracks.map(function (track) {
      return baseLanguage(track.languageCode);
    }));
    const usedKeys = new Set(tracks.map(trackKey));
    if (source) {
      (translationLanguages || []).forEach(function (lang, index) {
        const code = lang && lang.languageCode ? String(lang.languageCode) : "";
        if (!languageCodeOk(code)) return;
        const base = baseLanguage(code);
        if (!base || seen.has(base)) return;
        const candidate = {
          languageCode: code,
          kind: "translation",
          vssId: "tlang." + code,
          baseUrl: withTranslationUrl(source.baseUrl, code),
          hasPot: Boolean(source.hasPot),
          index: 10000 + index,
          youtubeName: lang.name || "",
          trackName: "",
          isTranslatable: false,
          isTranslation: true,
        };
        const key = trackKey(candidate);
        if (usedKeys.has(key)) return;
        seen.add(base);
        usedKeys.add(key);
        tracks.push(candidate);
      });
    }
    const labels = assignLabels(tracks);
    tracks.forEach(function (track, index) {
      track.key = trackKey(track);
      track.label = labels[index];
    });
    const manuals = [];
    const autos = [];
    const translations = [];
    tracks.forEach(function (track) {
      if (track.isTranslation) translations.push(track);
      else if (track.kind === "asr") autos.push(track);
      else manuals.push(track);
    });
    manuals.sort(function (a, b) { return a.index - b.index; });
    autos.sort(function (a, b) { return a.index - b.index; });
    translations.sort(function (a, b) {
      return String(a.label).localeCompare(String(b.label), "en");
    });
    return {
      tracks: manuals.concat(autos, translations),
      originalLanguage: original || "",
    };
  }

  // Real captions beat a translation of the same language. Within real
  // captions, the kind the user last chose wins, then manual, then auto.
  function kindScore(track, wantedKind) {
    const kind = track.kind || "";
    if (kind !== "translation" && kind === wantedKind) return 0;
    if (!kind) return 1;
    if (kind === "asr") return 2;
    return 3;
  }

  function bestLanguageMatch(tracks, languageCode, kind) {
    const matches = (tracks || []).filter(function (track) {
      return sameLanguage(track.languageCode, languageCode);
    });
    if (!matches.length) return null;
    const wanted = String(languageCode || "").toLowerCase();
    const wantedKind = kind || "";
    matches.sort(function (a, b) {
      const aExact = String(a.languageCode || "").toLowerCase() === wanted ? 0 : 1;
      const bExact = String(b.languageCode || "").toLowerCase() === wanted ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const score = kindScore(a, wantedKind) - kindScore(b, wantedKind);
      if (score) return score;
      return a.index - b.index;
    });
    return matches[0];
  }

  // Remembered language, then the video's own language, then the first
  // captions a person wrote. An explicit track key never falls back:
  // copying a different language than the one the user picked would be wrong.
  function pickTrack(tracks, remembered, originalLanguage) {
    const list = tracks || [];
    if (!list.length) return null;
    if (remembered && remembered.languageCode) {
      const rememberedMatch = bestLanguageMatch(list, remembered.languageCode, remembered.kind || "");
      if (rememberedMatch) return rememberedMatch;
    }
    const original = originalLanguage || inferOriginalLanguage(list);
    if (original) {
      const real = list.filter(function (track) { return !track.isTranslation; });
      const originalMatch = bestLanguageMatch(real, original, "");
      if (originalMatch) return originalMatch;
    }
    const manuals = list.filter(function (track) {
      return !track.isTranslation && track.kind !== "asr";
    }).sort(function (a, b) { return a.index - b.index; });
    if (manuals.length) return manuals[0];
    const real = list.filter(function (track) { return !track.isTranslation; })
      .sort(function (a, b) { return a.index - b.index; });
    if (real.length) return real[0];
    return null;
  }

  function resolveTrack(tracks, wantedKey, remembered, originalLanguage) {
    const list = tracks || [];
    if (wantedKey) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].key === wantedKey) return list[i];
      }
      return null;
    }
    return pickTrack(list, remembered, originalLanguage || "");
  }

  function publicTracks(tracks) {
    return (tracks || []).map(function (track) {
      return {
        key: track.key,
        label: track.label,
        languageCode: track.languageCode,
        kind: track.kind || "",
        auto: track.kind === "asr",
        translated: Boolean(track.isTranslation),
      };
    });
  }

  function timedTextUrl(baseUrl, clientName, format) {
    const url = new URL(String(baseUrl), "https://www.youtube.com");
    url.searchParams.set("fmt", format || "json3");
    if (!url.searchParams.get("c")) {
      url.searchParams.set("c", clientName || "WEB");
    }
    return url.toString();
  }

  function rawCues(events) {
    const cues = [];
    (events || []).forEach(function (event) {
      if (!event || !event.segs) return;
      const text = event.segs
        .map(function (seg) {
          return seg && seg.utf8 ? seg.utf8 : "";
        })
        .join("")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      cues.push({ start: event.tStartMs || 0, text: text });
    });
    return cues;
  }

  // Auto-captions sometimes repeat a growing line ("hi", "hi there", "hi there friend").
  function collapseRolling(cues) {
    const out = [];
    cues.forEach(function (cue) {
      const prev = out[out.length - 1];
      if (!prev) {
        out.push({ start: cue.start, text: cue.text });
        return;
      }
      if (cue.text === prev.text) return;
      if (cue.text.startsWith(prev.text) && cue.text.length > prev.text.length) {
        prev.text = cue.text;
        return;
      }
      out.push({ start: cue.start, text: cue.text });
    });
    return out;
  }

  function endsSentence(text) {
    return /[.!?…]["')\]]*$/.test(text) || /\.\.\.["')\]]*$/.test(text);
  }

  // Phrase-sized cues stay as their own lines. Word-sized cues are joined
  // until a pause, a sentence, or a comfortable line length.
  function toLines(cues) {
    if (!cues.length) return [];
    const lengths = cues.map(function (cue) {
      return cue.text.length;
    }).sort(function (a, b) {
      return a - b;
    });
    const median = lengths[Math.floor((lengths.length - 1) / 2)];
    if (median >= 12) return cues;

    const lines = [];
    let buf = "";
    let start = 0;
    let previousStart = 0;

    function flush() {
      const text = buf.replace(/\s+/g, " ").trim();
      if (text) lines.push({ start: start, text: text });
      buf = "";
    }

    cues.forEach(function (cue) {
      if (buf && cue.start - previousStart > 1200) flush();
      if (!buf) start = cue.start;
      buf = buf ? buf + " " + cue.text : cue.text;
      previousStart = cue.start;
      if (endsSentence(buf.trim()) || buf.trim().length >= 80) flush();
    });
    flush();
    return lines;
  }

  function decodeXml(value) {
    return String(value || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, num) {
        return String.fromCharCode(Number(num));
      })
      .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseSrv3(xml) {
    const lines = [];
    const pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>|<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = pattern.exec(xml))) {
      const attrs = match[1] || match[3] || "";
      const body = match[2] != null ? match[2] : match[4] || "";
      const millis = /(?:^|\s)t="(\d+(?:\.\d+)?)"/.exec(attrs);
      const seconds = /(?:^|\s)start="(\d+(?:\.\d+)?)"/.exec(attrs);
      let start = 0;
      if (millis) start = Math.round(Number(millis[1]));
      else if (seconds) start = Math.round(Number(seconds[1]) * 1000);
      const text = decodeXml(body);
      if (text) lines.push({ start: start, text: text });
    }
    return collapseRolling(lines);
  }

  function parseTimedText(body) {
    const trimmed = String(body || "").replace(/^\uFEFF/, "").trim();
    if (!trimmed) return { lines: [], empty: true };
    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
      try {
        const data = JSON.parse(trimmed);
        const events = Array.isArray(data) ? data : data.events || [];
        return { lines: toLines(collapseRolling(rawCues(events))) };
      } catch (error) {
        return { invalid: true, lines: null };
      }
    }
    if (trimmed.charAt(0) === "<") {
      return { lines: parseSrv3(trimmed) };
    }
    return { invalid: true, lines: null };
  }

  function formatTimestamp(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    if (hours > 0) return hours + ":" + mm + ":" + ss;
    return mm + ":" + ss;
  }

  function formatTranscript(info) {
    const title = info && info.title ? String(info.title).trim() : "";
    const url = info && info.url ? String(info.url).trim() : "";
    const lines = (info && info.lines) || [];
    const body = lines
      .map(function (line) {
        return formatTimestamp(line.start) + " — " + line.text;
      })
      .join("\n");
    return [title, url].filter(Boolean).join("\n") + "\n\n" + body;
  }

  globalThis.__ytCopyTranscriptLib = {
    normalizeTracks: normalizeTracks,
    normalizeTranslationLanguages: normalizeTranslationLanguages,
    originalLanguageFromFormats: originalLanguageFromFormats,
    originalLanguageFromAudioList: originalLanguageFromAudioList,
    buildTrackList: buildTrackList,
    resolveTrack: resolveTrack,
    publicTracks: publicTracks,
    timedTextUrl: timedTextUrl,
    parseTimedText: parseTimedText,
    formatTimestamp: formatTimestamp,
    formatTranscript: formatTranscript,
  };
})();
