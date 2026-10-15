// YouTube swaps videos without reloading the tab. Chrome only injects
// the content script on a full page load, so when the address becomes
// a watch link we inject it ourselves. The scripts ignore a second run.
const WATCH = /^https:\/\/(www\.)?youtube\.com\/watch(?:[/?#]|$)/;

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["transcript.js", "page-bridge.js"],
      world: "MAIN",
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ["styles.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"],
    });
  } catch (error) {
    // The tab can close, or the page can refuse injection. Nothing to show.
  }
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (!changeInfo.url || !WATCH.test(changeInfo.url)) return;
  inject(tabId);
});
