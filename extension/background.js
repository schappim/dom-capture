// Clicking the toolbar button (or Alt+Shift+C) injects the picker into the
// current tab. `activeTab` means we only ever touch a page the user asked for.
// picker.js toggles itself off when injected a second time.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/capture.js', 'src/picker.js'],
    });
  } catch (err) {
    // Privileged pages (chrome://, the extension gallery, the PDF viewer) cannot be scripted.
    console.warn('DOM Capture cannot run on this page:', err.message);
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId: tab.id });
    await chrome.action.setBadgeText({ text: '!', tabId: tab.id });
    await chrome.action.setTitle({ title: "DOM Capture can't run on this page", tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {}), 2500);
  }
});
