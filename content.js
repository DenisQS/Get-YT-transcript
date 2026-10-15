// Draws the "Copy transcript" button on a YouTube watch page and
// copies whatever the page bridge returns.
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
  const SOURCE = "yt-copy-transcript";
  const LABEL = "Copy transcript";

  const MESSAGES = {
    "no-captions": "No captions",
    "fetch-failed": "Couldn't load",
    clipboard: "Clipboard blocked",
  };

  let busy = false;
  let requestToken = 0;
  let revertTimer = 0;
  let seenVideoId = new URLSearchParams(location.search).get("v");

  function onWatchPage() {
    return location.pathname === "/watch";
  }

  function findAnchor() {
    return (
      document.querySelector("ytd-watch-metadata #top-level-buttons-computed") ||
      document.querySelector("ytd-watch-metadata #actions-inner") ||
      document.querySelector("ytd-watch-metadata #above-the-fold")
    );
  }

  function setLabel(button, text, state) {
    button.textContent = text;
    button.setAttribute("aria-label", text);
    if (state) button.dataset.state = state;
    else delete button.dataset.state;
    button.disabled = state === "busy";
  }

  function flash(button, text, state) {
    setLabel(button, text, state);
    clearTimeout(revertTimer);
    revertTimer = setTimeout(function () {
      const current = document.getElementById(BUTTON_ID);
      if (current) setLabel(current, LABEL, "");
    }, 2000);
  }

  function matchNeighbor(button) {
    const sample = document.querySelector("ytd-watch-metadata #top-level-buttons-computed button");
    if (!sample || sample === button) return;
    const style = getComputedStyle(sample);
    if (style.backgroundColor) button.style.setProperty("--ytct-bg", style.backgroundColor);
    if (style.color) button.style.setProperty("--ytct-fg", style.color);
    if (style.height) button.style.height = style.height;
  }

  function requestTranscript(videoId) {
    const requestId = Date.now().toString(36) + Math.random().toString(16).slice(2);
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
      window.postMessage(
        { source: SOURCE, type: "request", requestId: requestId, videoId: videoId },
        location.origin
      );
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

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const button = document.getElementById(BUTTON_ID);
    const videoId = new URLSearchParams(location.search).get("v");
    if (!button || !videoId) {
      if (button) flash(button, MESSAGES["fetch-failed"], "error");
      return;
    }
    busy = true;
    const token = ++requestToken;
    setLabel(button, "Copying…", "busy");
    const pending = requestTranscript(videoId);
    beginClipboardWrite(pending, function () {
      return token === requestToken;
    }).then(function (outcome) {
      if (token !== requestToken || outcome === "cancelled") return;
      busy = false;
      const current = document.getElementById(BUTTON_ID) || button;
      showOutcome(current, outcome);
    });
  }

  function createButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "yt-copy-transcript";
    setLabel(button, LABEL, "");
    button.addEventListener("click", onClick);
    return button;
  }

  function ensure() {
    const existing = document.getElementById(BUTTON_ID);
    if (!onWatchPage()) {
      if (existing) existing.remove();
      return;
    }
    const anchor = findAnchor();
    if (!anchor) return;
    const button = existing || createButton();
    if (button.parentElement !== anchor) anchor.appendChild(button);
    matchNeighbor(button);
  }

  function onNavigate() {
    const videoId = new URLSearchParams(location.search).get("v");
    if (videoId !== seenVideoId) {
      seenVideoId = videoId;
      requestToken++;
      busy = false;
      clearTimeout(revertTimer);
      const button = document.getElementById(BUTTON_ID);
      if (button) setLabel(button, LABEL, "");
    }
    ensure();
  }

  document.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("yt-page-data-updated", onNavigate);
  window.addEventListener("popstate", onNavigate);
  ensure();
  // YouTube rebuilds the like/share row without a full page load.
  setInterval(ensure, 1000);
})();
