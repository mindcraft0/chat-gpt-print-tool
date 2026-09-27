/*
 * events.js - единая точка событий расширения (аналитика #27).
 * Локальный счётчик в chrome.storage.local + отправка события в фоновый скрипт, который
 * шлёт его в GA4 (#27). Без содержимого диалогов - только счётчики и грубые свойства.
 * Работает как модуль Node (тесты) и как обычный скрипт в браузере (globalThis.CGPT_EVENTS).
 */

// Белый список имён событий. Расширять осознанно.
const EVENT_NAMES = [
  'export_started',
  'export_succeeded',
  'export_failed',
  'layout_drift',
  'content_dropped',
  'print_opened',
  'installed',
  'popup_opened',
  'review_prompt_shown',
  'review_prompt_accepted',
  'review_prompt_dismissed',
];
const EVENT_SET = new Set(EVENT_NAMES);
const STORAGE_KEY = 'cgpt_events';
const OPTOUT_KEY = 'cgpt_events_optout';

/**
 * Известно ли событие (только имена из белого списка).
 * @param {string} name
 * @returns {boolean}
 */
function isValidEvent(name) {
  return typeof name === 'string' && EVENT_SET.has(name);
}

// Разрешённые грубые свойства события. Никакого текста диалога/URL/персональных данных.
const ALLOWED_PROP_KEYS = new Set(['messages', 'images', 'durationMs', 'reason', 'strategy', 'dropped']);
const ALLOWED_REASONS = new Set(['no-messages', 'empty', 'quota', 'error', 'missing_turns']);
const ALLOWED_STRATEGY = new Set(['role', 'turn', 'article', 'markdown', 'none']);
// Какой тип контента пропал (канарейка #22). Только перечисление, без произвольных строк.
// 'turns' - не собрались целые сообщения; до 2026-09-07 этот случай уходил в аналитику
// БЕЗ единого свойства (reason не был в белом списке) и был неотличим от остальных (#86).
// 'images_capped' - картинки выброшены по потолку экспорта: потеря ЧАСТИЧНАЯ, поэтому
// отдельным значением, чтобы не путать с 'images' (тип пропал целиком).
// 'turns' - ход ЕСТЬ на странице, но не собрался (наша поломка).
// 'turns_absent' - хода с таким номером на странице нет вовсе: нумерация ChatGPT не
// сплошная после правки сообщения или перегенерации ответа, терять было нечего (#93).
const ALLOWED_DROPPED = new Set(['images', 'code', 'tables', 'turns', 'turns_absent', 'images_capped']);

/**
 * Оставляет только безопасные свойства: числа и короткие перечисления из белых
 * списков. Всё остальное (в т.ч. произвольные строки) отбрасывается - защита
 * приватности: содержимое диалога в события попасть не может.
 * @param {object} props
 * @returns {object}
 */
function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') {
    return out;
  }
  for (const key of Object.keys(props)) {
    if (!ALLOWED_PROP_KEYS.has(key)) {
      continue;
    }
    const v = props[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
    } else if (key === 'reason' && ALLOWED_REASONS.has(v)) {
      out[key] = v;
    } else if (key === 'strategy' && ALLOWED_STRATEGY.has(v)) {
      out[key] = v;
    } else if (key === 'dropped' && ALLOWED_DROPPED.has(v)) {
      out[key] = v;
    }
  }
  return out;
}

/*
 * Имя события для GA4. Тип потери зашивается В ИМЯ, а не только в параметр.
 * Зачем (разбор 09.09.2026, #86): параметр события GA4 показывает в отчётах ТОЛЬКО если
 * он заранее заведён в кабинете как специальное измерение, и только для данных, собранных
 * ПОСЛЕ этого. Измерение `dropped` не было заведено годами - тревога всё это время
 * приходила без указания типа, и задним числом GA4 её уже не покажет. Имена событий
 * отдаются всегда и за весь период, поэтому тип, зашитый в имя, потерять невозможно.
 * Параметр `dropped` при этом остаётся: он удобнее для разбивок внутри одного имени.
 */
const DROPPED_SUFFIX = {
  images: 'images',
  code: 'code',
  tables: 'tables',
  turns: 'turns',
  turns_absent: 'turns_absent',
  images_capped: 'capped',
};

/**
 * Имя, под которым событие уходит в GA4. Для content_dropped - с типом потери в имени
 * (content_dropped_images и т.п.), для остальных событий имя не меняется.
 * @param {string} name
 * @param {object} props - уже очищенные свойства
 * @returns {string}
 */
function ga4NameFor(name, props) {
  if (name !== 'content_dropped') {
    return name;
  }
  const suffix = props && DROPPED_SUFFIX[props.dropped];
  return suffix ? 'content_dropped_' + suffix : name;
}

/**
 * Чистое обновление счётчиков: возвращает НОВЫЙ объект с name+1 (исходный не меняет).
 * @param {object} counters
 * @param {string} name
 * @returns {object}
 */
function nextCounters(counters, name) {
  const base = counters && typeof counters === 'object' ? counters : {};
  const out = Object.assign({}, base);
  if (isValidEvent(name)) {
    out[name] = (typeof out[name] === 'number' ? out[name] : 0) + 1;
  }
  return out;
}

/**
 * Регистрирует событие: считает локально в chrome.storage.local. Никакой сети.
 * НИКОГДА не бросает исключение - телеметрия не должна ломать основную работу.
 * Это единственная точка, куда #26 позже добавит отправку.
 * @param {string} name
 * @param {object} [props]
 */
function track(name, props) {
  try {
    if (!isValidEvent(name)) {
      console.warn('CGPT events: неизвестное событие', name);
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      return;
    }
    const clean = sanitizeProps(props);
    chrome.storage.local.get([STORAGE_KEY, OPTOUT_KEY]).then((data) => {
      if (data && data[OPTOUT_KEY]) {
        return; // пользователь отключил телеметрию
      }
      const prev = data ? data[STORAGE_KEY] : null;
      const prevCounters = prev && prev.counters ? prev.counters : {};
      const record = {
        counters: nextCounters(prevCounters, name),
        last: { name, props: clean, at: Date.now() },
      };
      chrome.storage.local.set({ [STORAGE_KEY]: record }).catch(() => {});
      // Отправка в аналитику (#27): фоновый скрипт заберёт и отправит в GA4.
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'CGPT_ANALYTICS', name: ga4NameFor(name, clean), props: clean }).catch(() => {});
        }
      } catch (e) { /* аналитика не критична */ }
    }).catch(() => {});
  } catch (err) {
    try { console.warn('CGPT events: track дал сбой', err); } catch (e) { /* молча */ }
  }
}

/**
 * Сводка счётчиков (для отладки и будущего отчёта #26).
 * @returns {Promise<object>}
 */
async function getSummary() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      return {};
    }
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    return (data && data[STORAGE_KEY]) || {};
  } catch (err) {
    return {};
  }
}

const CGPT_EVENTS = { EVENT_NAMES, isValidEvent, sanitizeProps, nextCounters, ga4NameFor, track, getSummary };

// Двойной режим: модуль Node для тестов и глобальный объект для браузера.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CGPT_EVENTS;
}
if (typeof globalThis !== 'undefined') {
  globalThis.CGPT_EVENTS = CGPT_EVENTS;
}
