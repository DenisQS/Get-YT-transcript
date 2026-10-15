// Turns YouTube caption data into plain text with timestamps.
// This file does not touch the page. The page bridge calls it.
(function () {
  function isAuto(track) {
    if (!track) return false;
    if (track.kind === "asr") return true;
    return typeof track.vssId === "string" && track.vssId.startsWith("a.");
  }

  function urlHasPot(baseUrl) {
    try {
      return new URL(String(baseUrl), "https://www.youtube.com").searchParams.has("pot");
    } catch (error) {
      return false;
    }
  }

  // Keep one entry per language. If the player later adds a proof-of-origin
  // token (pot) to the same track, keep that URL — timedtext needs it.
  function normalizeTracks(rawTracks) {
    const map = new Map();
    (rawTracks || []).forEach(function (track, index) {
      if (!track) return;
      const languageCode = track.languageCode;
      const baseUrl = track.url || track.baseUrl;
      if (!languageCode || !baseUrl) return;
      const vssId = track.vssId || "";
      const kind = isAuto(track) ? "asr" : "";
      const key = languageCode + "|" + kind + "|" + vssId;
      const hasPot = urlHasPot(baseUrl);
      const existing = map.get(key);
      if (!existing || (hasPot && !existing.hasPot)) {
        map.set(key, {
          languageCode: languageCode,
          kind: kind,
          vssId: vssId,
          baseUrl: String(baseUrl),
          hasPot: hasPot,
          index: existing ? existing.index : index,
        });
      }
    });
    return Array.from(map.values());
  }

  function languageRank(code, preferred) {
    const norm = String(code || "").toLowerCase();
    const base = norm.split("-")[0];
    for (let i = 0; i < preferred.length; i++) {
      const wanted = String(preferred[i] || "").toLowerCase();
      if (!wanted) continue;
      if (wanted === norm) return i;
      if (wanted.split("-")[0] === base) return i + 0.5;
    }
    return 100;
  }

  // Manual captions first, then auto-generated. Within each group, prefer
  // the viewer's language, then the order YouTube listed (usually the original).
  function chooseTrack(tracks, preferred) {
    const ranked = (tracks || []).map(function (track, index) {
      return {
        track: track,
        index: typeof track.index === "number" ? track.index : index,
        manual: track.kind !== "asr",
        lang: languageRank(track.languageCode, preferred || []),
      };
    });
    ranked.sort(function (a, b) {
      if (a.manual !== b.manual) return a.manual ? -1 : 1;
      if (a.lang !== b.lang) return a.lang - b.lang;
      return a.index - b.index;
    });
    return ranked.length ? ranked[0].track : null;
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
    chooseTrack: chooseTrack,
    timedTextUrl: timedTextUrl,
    parseTimedText: parseTimedText,
    formatTimestamp: formatTimestamp,
    formatTranscript: formatTranscript,
  };
})();
