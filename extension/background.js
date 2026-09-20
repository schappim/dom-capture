// Clicking the toolbar button (or Alt+Shift+C) injects the picker into the
// current tab. `activeTab` means we only ever touch a page the user asked for.
// picker.js toggles itself off when injected a second time.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await injectCapture(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/picker.js'] });
  } catch (err) {
    // Privileged pages (chrome://, the extension gallery, the PDF viewer) cannot be scripted.
    console.warn('DOM Capture cannot run on this page:', err.message);
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: tab.id });
    await chrome.action.setBadgeText({ text: '!', tabId: tab.id });
    await chrome.action.setTitle({ title: "DOM Capture can't run on this page", tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {}), 2500);
  }
});

// capture.js goes into every frame we may touch, so that an <iframe> can be captured with the
// document it is showing. `activeTab` covers the page and its same-origin frames; a frame from
// another site needs the user to grant that site (see "allow-frames" below). It is a no-op in a
// frame that already has it.
async function injectCapture(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/capture.js'] });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/capture.js'] });
  }
}

const patterns = (origins) => origins.filter((o) => /^https?:\/\/[^/*]+$/.test(o)).map((o) => `${o}/*`);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const tabId = msg?.tabId ?? sender.tab?.id; // (permit.html names the tab it is asking for)
  if (!tabId || typeof msg?.type !== 'string') return;

  // A frame answering its parent's capture request: content scripts cannot talk to each other
  // directly, and the answer must not travel through the page (window.postMessage).
  if (msg.type === 'dom-capture:frame') {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    return;
  }

  // The picker, right before a capture: frames may have appeared since the toolbar click.
  if (msg.type === 'dom-capture:refresh-frames') {
    injectCapture(tabId).then(
      () => respond({ ok: true }),
      () => respond({ ok: false }),
    );
    return true;
  }

  // The picker found an <iframe> from a site we have no access to, and the user pressed "Allow".
  // Asking needs a user gesture; one made in a content script does not always count, so when the
  // request is refused for that reason a small extension window asks instead (permit.html).
  if (msg.type === 'dom-capture:allow-frames') {
    const origins = patterns(msg.origins || []);
    if (!origins.length) return respond({ ok: false });
    (async () => {
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins });
      } catch {
        const url = chrome.runtime.getURL(`permit.html?tab=${tabId}&origins=${encodeURIComponent(msg.origins.join(','))}`);
        await chrome.windows.create({ url, type: 'popup', width: 460, height: 300 });
        return respond({ ok: false, asking: true }); // permit.js reports back with "frames-allowed"
      }
      if (granted) await injectCapture(tabId).catch(() => {});
      respond({ ok: granted });
    })();
    return true;
  }

  // permit.html got the grant: bring the frames in and let the picker have another go.
  if (msg.type === 'dom-capture:frames-allowed') {
    injectCapture(tabId)
      .catch(() => {})
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'dom-capture:retry' }, { frameId: 0 }).catch(() => {}));
  }
});
