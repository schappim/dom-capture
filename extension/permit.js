// Asks for access to the site(s) of a cross-origin <iframe>. This lives in an extension page
// because chrome.permissions.request() wants a click it can trust — see background.js.
const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
const origins = (params.get('origins') || '').split(',').filter((o) => /^https?:\/\/[^/*]+$/.test(o));

document.getElementById('origins').textContent = origins.join('\n');
document.getElementById('cancel').addEventListener('click', () => window.close());
document.getElementById('allow').addEventListener('click', async () => {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: origins.map((o) => `${o}/*`) });
  } catch (err) {
    console.warn(err);
  }
  if (granted) await chrome.runtime.sendMessage({ type: 'dom-capture:frames-allowed', tabId });
  window.close();
});
