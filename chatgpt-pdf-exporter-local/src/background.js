/*
 * background.js - служебный сценарий (service worker). По команде из попапа запускает
 * сбор разговора на активной вкладке; если сбор-часть ещё не внедрена (частый случай:
 * вкладка была открыта до установки расширения), внедряет её и повторяет запуск.
 * Отдельно по просьбе сбор-части открывает готовую страницу печати новой вкладкой.
 */

// Конфиг и GA4-сендер в service worker (классический SW: importScripts синхронный).
try { importScripts('config.js', 'ga4.js'); } catch (e) { console.error('CGPT bg: importScripts', e); }

// Устойчивый анонимный идентификатор пользователя для аналитики (генерится один раз).
function genClientId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) { return crypto.randomUUID(); }
  } catch (e) { /* ignore */ }
  return Date.now().toString(36) + '-' + Math.random().toString(16).slice(2);
}
async function getClientId() {
  try {
    const data = await chrome.storage.local.get(['cgpt_client_id']);
    let cid = data && data.cgpt_client_id;
    if (!cid) { cid = genClientId(); await chrome.storage.local.set({ cgpt_client_id: cid }); }
    return cid;
  } catch (e) { return 'anon'; }
}

// Установка: событие воронки "installed" + страница-опрос при удалении.
chrome.runtime.onInstalled.addListener((details) => {
  getClientId().then((cid) => {
    try {
      const cfg = globalThis.CGPT_CONFIG || {};
      if (chrome.runtime.setUninstallURL && cfg.UNINSTALL_SURVEY_URL) {
        const sep = cfg.UNINSTALL_SURVEY_URL.indexOf('?') === -1 ? '?' : '&';
        chrome.runtime.setUninstallURL(cfg.UNINSTALL_SURVEY_URL + sep + 'cid=' + encodeURIComponent(cid));
      }
      if (details && details.reason === 'install' && globalThis.CGPT_GA4) {
        globalThis.CGPT_GA4.sendToGA4(cid, 'installed', {});
      }
    } catch (e) { console.error('CGPT bg: onInstalled', e); }
  });
});

// Гейтинг иконки расширения: активна и открывает попап ТОЛЬКО на ChatGPT.
// На всех остальных сайтах иконка серая (disabled) и попап не открывается вообще.
// Делается штатно через declarativeContent: правило переживает перезапуски SW.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.action.disable(); // по умолчанию выключено везде
    if (chrome.declarativeContent && chrome.declarativeContent.onPageChanged) {
      chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
        chrome.declarativeContent.onPageChanged.addRules([{
          conditions: [
            new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: 'chatgpt.com' } }),
            new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: 'chat.openai.com' } })
          ],
          actions: [new chrome.declarativeContent.ShowAction()] // включает иконку/попап на ChatGPT
        }]);
      });
    }
  } catch (e) { console.error('CGPT bg: настройка гейтинга иконки', e); }
});

// Файлы сбор-части в порядке подключения (тот же порядок, что в manifest content_scripts).
const CONTENT_FILES = ['src/events.js', 'src/lib.js', 'src/dom-scan.js', 'src/content.js'];

/**
 * Проверяет, что адрес вкладки это страница ChatGPT (иначе внедрять сбор-часть некуда).
 * @param {string} url
 * @returns {boolean}
 */
function isChatUrl(url) {
  return typeof url === 'string'
    && (/^https:\/\/chatgpt\.com\//.test(url) || /^https:\/\/chat\.openai\.com\//.test(url));
}

/**
 * Сообщает попапу об ошибке запуска (попап показывает её и снова включает кнопку).
 * @param {string} text
 */
function notifyError(text) {
  chrome.runtime.sendMessage({ type: 'CGPT_ERROR', message: text }).catch(() => {});
}

/**
 * Запускает сбор на активной вкладке. Если получателя нет (сбор-часть не внедрена),
 * внедряет её и повторяет команду, чтобы запуск работал и на вкладках, открытых до
 * установки расширения.
 */
async function startExportOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    notifyError('No active tab found.');
    return;
  }
  if (!isChatUrl(tab.url)) {
    notifyError('Open a conversation on chatgpt.com and try again.');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'CGPT_EXPORT' });
  } catch (err) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      await chrome.tabs.sendMessage(tab.id, { type: 'CGPT_EXPORT' });
    } catch (err2) {
      console.error('CGPT background: не удалось запустить сбор на вкладке', err2);
      notifyError('Could not start collecting on this tab. Reload the ChatGPT page and try again.');
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  try {
    if (message && message.type === 'CGPT_START') {
      startExportOnActiveTab();
    } else if (message && message.type === 'CGPT_OPEN_PRINT' && message.key) {
      const url = chrome.runtime.getURL('src/print/print.html') + '?k=' + encodeURIComponent(message.key);
      chrome.tabs.create({ url });
    } else if (message && message.type === 'CGPT_ANALYTICS' && message.name) {
      // Событие от track() из другого контекста -> отправляем в GA4 фоном.
      getClientId().then((cid) => {
        if (globalThis.CGPT_GA4) { globalThis.CGPT_GA4.sendToGA4(cid, message.name, message.props || {}); }
      });
    }
  } catch (err) {
    console.error('CGPT background: ошибка обработки сообщения', err);
  }
});
