/*
 * ga4.js - отправка событий в GA4 через Measurement Protocol (#27). Работает в service
 * worker (background): туда track() из остальных контекстов шлёт событие сообщением,
 * а фоновый скрипт отправляет его в GA4. Сеть в MV3 разрешена (запрещён только внешний
 * КОД, а не сетевые запросы). Никогда не бросает: сбой аналитики не ломает продукт.
 * Ключи берёт из globalThis.CGPT_CONFIG (config.js). Чистые помощники тестируются.
 */

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

function getConfig() {
  return (typeof globalThis !== 'undefined' && globalThis.CGPT_CONFIG) || {};
}

/**
 * Заведён ли поток GA4 (ключи проставлены, не плейсхолдеры).
 * @param {object} cfg
 * @returns {boolean}
 */
function isConfigured(cfg) {
  const c = cfg || {};
  const mid = c.GA4_MEASUREMENT_ID || '';
  const sec = c.GA4_API_SECRET || '';
  return mid.length > 0 && sec.length > 0
    && mid.indexOf('PLACEHOLDER') === -1 && sec.indexOf('PLACEHOLDER') === -1;
}

/**
 * Имя события под требования GA4: [a-z0-9_], до 40 символов.
 * @param {string} name
 * @returns {string}
 */
function ga4EventName(name) {
  return String(name || 'event').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
}

/**
 * Тело запроса Measurement Protocol. Чистая функция - тестируется.
 * @param {string} clientId
 * @param {string} name
 * @param {object} params
 * @returns {{client_id:string, events:Array<{name:string, params:object}>}}
 */
function buildGa4Body(clientId, name, params) {
  return {
    client_id: clientId || 'anon',
    events: [{ name: ga4EventName(name), params: params || {} }],
  };
}

/**
 * Отправляет одно событие в GA4. Молчит, если поток не заведён. Никогда не бросает.
 * @param {string} clientId
 * @param {string} name
 * @param {object} params
 * @returns {Promise<void>}
 */
async function sendToGA4(clientId, name, params) {
  try {
    const cfg = getConfig();
    if (!isConfigured(cfg)) {
      return; // поток GA4 ещё не заведён - тихо выходим
    }
    if (typeof fetch === 'undefined') {
      return;
    }
    const url = GA4_ENDPOINT
      + '?measurement_id=' + encodeURIComponent(cfg.GA4_MEASUREMENT_ID)
      + '&api_secret=' + encodeURIComponent(cfg.GA4_API_SECRET);
    await fetch(url, { method: 'POST', body: JSON.stringify(buildGa4Body(clientId, name, params)) });
  } catch (err) {
    // аналитика не должна ломать работу расширения
  }
}

const CGPT_GA4 = { isConfigured, ga4EventName, buildGa4Body, sendToGA4 };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CGPT_GA4;
}
if (typeof globalThis !== 'undefined') {
  globalThis.CGPT_GA4 = CGPT_GA4;
}
