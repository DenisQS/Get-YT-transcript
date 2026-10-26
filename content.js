// Draws the "Copy transcript" button on a YouTube watch page and
// copies whatever the page bridge returns. The arrow beside the button
// lists this video's caption languages.
(function () {
  if (globalThis.__ytCopyTranscriptContent) {
    globalThis.__ytCopyTranscriptContent.ensure();
    return;
  }
  // Set this before any listener so a second injection does not bind twice.
  globalThis.__ytCopyTranscriptContent = {
    ensure: function () {
      ensure();
    },
  };

  const BUTTON_ID = "yt-copy-transcript";
  const WRAP_ID = "yt-copy-transcript-wrap";
  const LANG_ID = "yt-copy-transcript-lang";
  const LANG_NAME_ID = "yt-copy-transcript-lang-name";
  const MENU_ID = "yt-copy-transcript-menu";
  const SOURCE = "yt-copy-transcript";
  const LABEL = "Copy transcript";
  const MEMORY_KEY = "yt-copy-transcript-language";

  const MESSAGES = {
    "no-captions": "No captions",
    "fetch-failed": "Couldn't load",
    clipboard: "Clipboard blocked",
  };

  let busy = false;
  let requestToken = 0;
  let listToken = 0;
  let revertTimer = 0;
  let menuOpen = false;
  let userPicked = false;
  let tracks = [];
  let selectedKey = "";
  let listError = "";
  let listPending = false;
  let listVideoId = "";
  let seenVideoId = currentVideoId();

  function onWatchPage() {
    return location.pathname === "/watch";
  }

  function currentVideoId() {
    if (location.pathname !== "/watch") return "";
    return new URLSearchParams(location.search).get("v") || "";
  }

  function findAnchor() {
    return (
      document.querySelector("ytd-watch-metadata #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #actions-inner") ||
      document.querySelector("ytd-watch-metadata #above-the-fold")
    );
  }

  function readRemembered() {
    try {
      const raw = localStorage.getItem(MEMORY_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data.languageCode !== "string" || !data.languageCode.trim()) return null;
      const kind = data.kind === "asr" || data.kind === "translation" ? data.kind : "";
      return { languageCode: data.languageCode.trim(), kind: kind };
    } catch (error) {
      return null;
    }
  }

  function writeRemembered(track) {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify({
        languageCode: track.languageCode,
        kind: track.kind === "asr" || track.kind === "translation" ? track.kind : "",
      }));
    } catch (error) {
      // Storage can be blocked. The choice still applies to this video.
    }
  }

  function selectedTrack() {
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].key === selectedKey) return tracks[i];
    }
    return null;
  }

  function syncLangButton() {
    const lang = document.getElementById(LANG_ID);
    const name = document.getElementById(LANG_NAME_ID);
    const current = selectedTrack();
    const label = current && current.label ? current.label : "";
    if (name) name.textContent = label;
    if (lang) {
      const text = label ? "Caption language: " + label : "Choose caption language";
      lang.setAttribute("aria-label", text);
      lang.title = text;
    }
    const button = document.getElementById(BUTTON_ID);
    if (button && !button.dataset.state) {
      button.title = label ? "Copies the transcript in " + label : "Copy the transcript";
    }
  }

  function setLabel(button, text, state) {
    button.textContent = text;
    button.setAttribute("aria-label", text);
    if (state) button.dataset.state = state;
    else delete button.dataset.state;
    button.disabled = state === "busy";
    const lang = document.getElementById(LANG_ID);
    if (lang) lang.disabled = state === "busy";
    if (!state) syncLangButton();
  }

  function flash(button, text, state) {
    setLabel(button, text, state);
    clearTimeout(revertTimer);
    revertTimer = setTimeout(function () {
      const current = document.getElementById(BUTTON_ID);
      if (current) setLabel(current, LABEL, "");
    }, 2000);
  }

  function matchNeighbor() {
    const wrap = document.getElementById(WRAP_ID);
    const button = document.getElementById(BUTTON_ID);
    const lang = document.getElementById(LANG_ID);
    const sample = document.querySelector(
      "ytd-watch-metadata #top-level-buttons-computed ytd-button-renderer button, " +
      "ytd-watch-metadata #top-level-buttons-computed button"
    );
    if (!wrap || !sample || sample === button || sample === lang) return;
    const style = getComputedStyle(sample);
    if (style.backgroundColor) wrap.style.setProperty("--ytct-bg", style.backgroundColor);
    if (style.color) wrap.style.setProperty("--ytct-fg", style.color);
    const height = style.height;
    if (height && button) button.style.height = height;
    if (height && lang) lang.style.height = height;
  }

  // page-bridge.js runs in the page's own script world, which can start
  // after this file. Wait until it marks the page, or the message is lost.
  function bridgeReady() {
    if (document.documentElement && document.documentElement.dataset.ytCopyTranscriptBridge === "1") {
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      const started = Date.now();
      const timer = setInterval(function () {
        const root = document.documentElement;
        if ((root && root.dataset.ytCopyTranscriptBridge === "1") || Date.now() - started > 5000) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  function postBridge(type, fields) {
    const requestId = Date.now().toString(36) + Math.random().toString(16).slice(2);
    return bridgeReady().then(function () {
      return new Promise(function (resolve) {
        const timeout = setTimeout(function () {
          window.removeEventListener("message", onMessage);
          resolve({ ok: false, error: "fetch-failed" });
        }, 20000);

        function onMessage(event) {
          if (event.source !== window) return;
          const data = event.data;
          if (!data || data.source !== SOURCE || data.type !== "response") return;
          if (data.requestId !== requestId) return;
          clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          resolve(data.payload || { ok: false, error: "fetch-failed" });
        }

        window.addEventListener("message", onMessage);
        const message = {
          source: SOURCE,
          type: type,
          requestId: requestId,
          videoId: fields.videoId,
          remembered: fields.remembered || null,
        };
        if (type === "request") message.trackKey = fields.trackKey || "";
        window.postMessage(message, location.origin);
      });
    });
  }

  function fallbackCopy(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "0";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (error) {
      return false;
    }
  }

  // Start the clipboard write during the click. The transcript text can
  // arrive a moment later; Chrome accepts a Blob promise for that.
  function beginClipboardWrite(pending, isCurrent) {
    let settled = null;
    const remembered = pending.then(function (result) {
      settled = result;
      return result;
    });

    function stillCurrent(result) {
      if (!isCurrent()) return "cancelled";
      if (!result || !result.ok) return (result && result.error) || "fetch-failed";
      return null;
    }

    if (navigator.clipboard && window.ClipboardItem) {
      try {
        const blobPromise = remembered.then(function (result) {
          const blocked = stillCurrent(result);
          if (blocked) throw Object.assign(new Error(blocked), { code: blocked });
          return new Blob([result.text], { type: "text/plain" });
        });
        const item = new ClipboardItem({ "text/plain": blobPromise });
        return navigator.clipboard.write([item]).then(function () {
          return isCurrent() ? "copied" : "cancelled";
        }).catch(async function () {
          if (!settled) {
            try {
              settled = await remembered;
            } catch (error) {
              return "fetch-failed";
            }
          }
          const blocked = stillCurrent(settled);
          if (blocked) return blocked;
          return fallbackCopy(settled.text) ? "copied" : "clipboard";
        });
      } catch (error) {
        // ClipboardItem was refused. Fall through to writeText.
      }
    }

    return remembered.then(async function (result) {
      const blocked = stillCurrent(result);
      if (blocked) return blocked;
      try {
        await navigator.clipboard.writeText(result.text);
        return isCurrent() ? "copied" : "cancelled";
      } catch (error) {
        if (!isCurrent()) return "cancelled";
        return fallbackCopy(result.text) ? "copied" : "clipboard";
      }
    });
  }

  function showOutcome(button, outcome) {
    if (outcome === "copied") flash(button, "Copied!", "success");
    else if (outcome === "clipboard") flash(button, MESSAGES.clipboard, "error");
    else flash(button, MESSAGES[outcome] || MESSAGES["fetch-failed"], "error");
  }

  function applyTrackResult(videoId, result) {
    if (!result || !result.ok || !result.track) return;
    if (currentVideoId() !== videoId) return;
    const known = tracks.some(function (track) { return track.key === result.track.key; });
    if (!known) tracks = tracks.concat([result.track]);
    if (!userPicked) selectedKey = result.track.key;
    syncLangButton();
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    closeMenu();
    const button = document.getElementById(BUTTON_ID);
    const videoId = currentVideoId();
    if (!button || !videoId) {
      if (button) flash(button, MESSAGES["fetch-failed"], "error");
      return;
    }
    busy = true;
    const token = ++requestToken;
    setLabel(button, "Copying…", "busy");
    const pending = postBridge("request", {
      videoId: videoId,
      trackKey: selectedKey,
      remembered: readRemembered(),
    });
    pending.then(function (result) {
      applyTrackResult(videoId, result);
    });
    beginClipboardWrite(pending, function () {
      return token === requestToken;
    }).then(function (outcome) {
      if (token !== requestToken || outcome === "cancelled") return;
      busy = false;
      const current = document.getElementById(BUTTON_ID) || button;
      showOutcome(current, outcome);
    });
  }

  function chevronIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M6 9l6 6 6-6");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function createControls() {
    const wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    wrap.className = "yt-copy-transcript-wrap";

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "yt-copy-transcript";
    setLabel(button, LABEL, "");
    button.addEventListener("click", onClick);

    const lang = document.createElement("button");
    lang.id = LANG_ID;
    lang.type = "button";
    lang.className = "yt-copy-transcript-lang";
    lang.setAttribute("aria-haspopup", "listbox");
    lang.setAttribute("aria-expanded", "false");
    lang.setAttribute("aria-controls", MENU_ID);
    const name = document.createElement("span");
    name.id = LANG_NAME_ID;
    name.className = "yt-copy-transcript-lang-name";
    lang.appendChild(name);
    lang.appendChild(chevronIcon());
    lang.addEventListener("click", onLangClick);

    wrap.appendChild(button);
    wrap.appendChild(lang);
    return wrap;
  }

  function ensureMenu() {
    if (!document.body) return null;
    let menu = document.getElementById(MENU_ID);
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.className = "yt-copy-transcript-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Caption languages");
    document.body.appendChild(menu);
    return menu;
  }

  function closeMenu() {
    menuOpen = false;
    const menu = document.getElementById(MENU_ID);
    const lang = document.getElementById(LANG_ID);
    if (menu) menu.hidden = true;
    if (lang) lang.setAttribute("aria-expanded", "false");
  }

  function renderMenu() {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    menu.textContent = "";
    if (!tracks.length) {
      const empty = document.createElement("div");
      empty.className = "yt-copy-transcript-menu-empty";
      if (listPending) empty.textContent = "Loading…";
      else if (listError === "no-captions") empty.textContent = "No captions";
      else empty.textContent = "Couldn't load";
      menu.appendChild(empty);
      return;
    }
    let sawTranslation = false;
    tracks.forEach(function (track) {
      if (track.translated && !sawTranslation) {
        sawTranslation = true;
        const heading = document.createElement("div");
        heading.className = "yt-copy-transcript-menu-heading";
        heading.textContent = "Translated";
        menu.appendChild(heading);
      }
      const option = document.createElement("button");
      option.type = "button";
      option.className = "yt-copy-transcript-option";
      if (track.key === selectedKey) option.classList.add("is-selected");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", track.key === selectedKey ? "true" : "false");
      option.setAttribute("data-key", track.key);
      option.title = track.label;
      option.addEventListener("click", onOptionClick);

      const mark = document.createElement("span");
      mark.className = "yt-copy-transcript-option-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = track.key === selectedKey ? "✓" : "";

      const text = document.createElement("span");
      text.className = "yt-copy-transcript-option-label";
      text.textContent = track.label;

      option.appendChild(mark);
      option.appendChild(text);
      menu.appendChild(option);
    });
  }

  function positionMenu() {
    const wrap = document.getElementById(WRAP_ID);
    const menu = document.getElementById(MENU_ID);
    if (!wrap || !menu || menu.hidden) return;
    const rect = wrap.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      closeMenu();
      return;
    }
    const width = menu.offsetWidth || 240;
    const height = menu.offsetHeight || 0;
    let left = rect.right - width;
    const maxLeft = window.innerWidth - width - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;
    let top = rect.bottom + 6;
    if (height && top + height > window.innerHeight - 8) {
      const above = rect.top - height - 6;
      if (above >= 8) top = above;
    }
    menu.style.top = Math.round(top) + "px";
    menu.style.left = Math.round(left) + "px";
  }

  function revealSelected() {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    const selected = menu.querySelector(".yt-copy-transcript-option.is-selected");
    const target = selected || menu.querySelector(".yt-copy-transcript-option");
    if (!target) return;
    const top = target.offsetTop;
    const bottom = top + target.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
    target.focus();
  }

  function openMenu() {
    const menu = ensureMenu();
    const lang = document.getElementById(LANG_ID);
    if (!menu || !lang) return;
    const videoId = currentVideoId();
    renderMenu();
    menu.hidden = false;
    lang.setAttribute("aria-expanded", "true");
    menuOpen = true;
    positionMenu();
    revealSelected();
    if (videoId && (listVideoId !== videoId || !tracks.length)) {
      refreshTracks(videoId).then(function () {
        if (!menuOpen || currentVideoId() !== videoId) return;
        renderMenu();
        positionMenu();
        revealSelected();
      });
    }
  }

  function onLangClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (menuOpen) closeMenu();
    else openMenu();
  }

  function onOptionClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const key = event.currentTarget.getAttribute("data-key");
    let track = null;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].key === key) track = tracks[i];
    }
    if (!track) return;
    selectedKey = track.key;
    userPicked = true;
    writeRemembered(track);
    syncLangButton();
    closeMenu();
    const lang = document.getElementById(LANG_ID);
    if (lang) lang.focus();
  }

  function refreshTracks(videoId) {
    const token = ++listToken;
    listVideoId = videoId;
    listPending = true;
    listError = "";
    if (menuOpen) renderMenu();
    return postBridge("list-tracks", {
      videoId: videoId,
      remembered: readRemembered(),
    }).then(function (payload) {
      if (token !== listToken || currentVideoId() !== videoId) return;
      listPending = false;
      if (!payload || !payload.ok || !payload.tracks || !payload.tracks.length) {
        tracks = [];
        selectedKey = "";
        userPicked = false;
        listError = (payload && payload.error) || "fetch-failed";
      } else {
        tracks = payload.tracks;
        listError = "";
        const stillThere = userPicked && tracks.some(function (track) {
          return track.key === selectedKey;
        });
        if (!stillThere) {
          userPicked = false;
          selectedKey = payload.selectedKey || "";
        }
      }
      syncLangButton();
      if (menuOpen) {
        renderMenu();
        positionMenu();
        revealSelected();
      }
    });
  }

  function ensure() {
    if (!onWatchPage()) {
      closeMenu();
      const wrap = document.getElementById(WRAP_ID);
      const menu = document.getElementById(MENU_ID);
      const stray = document.getElementById(BUTTON_ID);
      if (wrap) wrap.remove();
      if (menu) menu.remove();
      else if (stray) stray.remove();
      return;
    }
    const anchor = findAnchor();
    if (!anchor) return;
    const wrap = document.getElementById(WRAP_ID) || createControls();
    if (wrap.parentElement !== anchor) anchor.appendChild(wrap);
    ensureMenu();
    matchNeighbor();
    syncLangButton();
    if (busy) {
      const button = document.getElementById(BUTTON_ID);
      if (button && button.dataset.state !== "busy") setLabel(button, "Copying…", "busy");
    }
  }

  function resetForNewVideo() {
    requestToken++;
    listToken++;
    busy = false;
    userPicked = false;
    tracks = [];
    selectedKey = "";
    listError = "";
    listPending = false;
    listVideoId = "";
    clearTimeout(revertTimer);
    closeMenu();
    const menu = document.getElementById(MENU_ID);
    if (menu) menu.textContent = "";
    const button = document.getElementById(BUTTON_ID);
    if (button) setLabel(button, LABEL, "");
    else syncLangButton();
  }

  function onNavigate() {
    const videoId = currentVideoId();
    if (videoId !== seenVideoId) {
      seenVideoId = videoId;
      resetForNewVideo();
      if (videoId) refreshTracks(videoId);
    }
    ensure();
  }

  document.addEventListener("click", function (event) {
    if (!menuOpen) return;
    const wrap = document.getElementById(WRAP_ID);
    const menu = document.getElementById(MENU_ID);
    if (wrap && wrap.contains(event.target)) return;
    if (menu && menu.contains(event.target)) return;
    closeMenu();
  }, true);

  document.addEventListener("keydown", function (event) {
    if (!menuOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      const lang = document.getElementById(LANG_ID);
      if (lang) lang.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    const options = menu.querySelectorAll(".yt-copy-transcript-option");
    if (!options.length) return;
    event.preventDefault();
    event.stopPropagation();
    let index = -1;
    for (let i = 0; i < options.length; i++) {
      if (options[i] === document.activeElement) index = i;
    }
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (index + delta + options.length) % options.length;
    options[next].focus();
  }, true);

  window.addEventListener("resize", function () {
    if (menuOpen) positionMenu();
  });
  window.addEventListener("scroll", function () {
    if (menuOpen) positionMenu();
  }, true);

  document.addEventListener("yt-navigate-start", onNavigate);
  document.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("yt-page-data-updated", onNavigate);
  window.addEventListener("popstate", onNavigate);
  ensure();
  if (seenVideoId) refreshTracks(seenVideoId);
  // YouTube rebuilds the like/share row without a full page load.
  setInterval(ensure, 1000);
})();
