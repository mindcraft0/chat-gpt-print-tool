/*
 * lib.js - чистые функции сбора и очистки разметки разговора ChatGPT.
 * Работает и как модуль Node (для тестов), и как обычный скрипт в браузере
 * (вешает функции на globalThis.CGPT), поэтому вся логика без внешних зависимостей.
 */

/**
 * Достаёт из узла формулы KaTeX чистый MathML.
 * Почему так: ChatGPT рендерит формулу через KaTeX и рядом кладёт скрытый
 * блок .katex-mathml с настоящим <math>. Берём его, чтобы Chrome сам отрисовал
 * формулу при печати без подключения шрифтов KaTeX.
 * @param {Element} katexEl - корневой узел .katex
 * @returns {string} разметка MathML или запасной вариант с исходной записью формулы
 */
function mathmlFromKatex(katexEl) {
  try {
    // В Node нет DOM-узлов - защищаемся, чтобы функция не падала при импорте.
    if (!katexEl || typeof katexEl.querySelector !== 'function') {
      return '';
    }

    const mathNode = katexEl.querySelector('.katex-mathml math');
    if (mathNode) {
      return mathNode.outerHTML;
    }

    // Запасной вариант: аннотация с исходной TeX-записью формулы. Текст экранируем,
    // потому что дальше он попадёт в innerHTML и не должен трактоваться как разметка.
    const annotation = katexEl.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation && annotation.textContent) {
      return '<code>$' + escapeText(annotation.textContent.trim()) + '$</code>';
    }

    // Совсем крайний случай - хоть какой-то текст, тоже экранируем.
    return escapeText(katexEl.textContent || '');
  } catch (err) {
    console.error('CGPT: mathmlFromKatex не смог разобрать формулу', err);
    return katexEl && katexEl.textContent ? escapeText(katexEl.textContent) : '';
  }
}

// Белый список: только эти обычные HTML-теги оставляем в печатном документе.
const ALLOWED_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'IMG', 'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL',
  'BR', 'HR', 'DIV', 'SUP', 'SUB',
]);

// Эти теги удаляем вместе с содержимым: опасные или чисто служебные.
// ВНИМАНИЕ: BUTTON здесь НЕ должен быть - решение по кнопке принимается ОТДЕЛЬНО,
// по её содержимому (см. isButtonEl/buttonWrapsImage в sanitizeElement):
//   - кнопка С картинкой (клик-зум вокруг <img> чата) - разворачивается, картинка живёт;
//   - кнопка БЕЗ картинки (панель блока кода: Copy/Edit/Run) - удаляется целиком.
// Если внести BUTTON сюда, вырежем картинки чата; если убрать особую ветку -
// подписи кнопок интерфейса протекут в документ (баг 2026-07-11).
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE',
  'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'SVG', 'NOSCRIPT', 'TEMPLATE',
]);

// Разрешённые атрибуты по тегам (класс разрешён везде: он нужен для оформления).
const ALLOWED_ATTRS = { A: new Set(['href']), IMG: new Set(['src', 'alt']), SPAN: new Set(['data-tex']) };

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const SAFE_URL = /^(https?:|mailto:|data:image\/)/i;

/**
 * Это кнопка интерфейса? Считаем кнопкой и <button>, и любой узел с role="button"
 * (ChatGPT размечает так часть своих управляющих элементов).
 * @param {Element} el
 * @returns {boolean}
 */
function isButtonEl(el) {
  if (!el) return false;
  const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
  if (tag === 'BUTTON') return true;
  const role = el.getAttribute ? el.getAttribute('role') : null;
  return String(role || '').toLowerCase() === 'button';
}

/**
 * Кнопка обёрнута вокруг картинки чата? Такую надо развернуть (сохранив <img>);
 * кнопку без картинки - удалить целиком, иначе её подпись («Edit») протекает в PDF.
 * @param {Element} el
 * @returns {boolean}
 */
function buttonWrapsImage(el) {
  return !!(el && typeof el.querySelector === 'function' && el.querySelector('img'));
}

/**
 * Ссылка/адрес картинки безопасны только при разрешённом протоколе (не javascript: и т.п.).
 * @param {string} value
 * @returns {boolean}
 */
function isSafeUrl(value) {
  return typeof value === 'string' && SAFE_URL.test(value.trim());
}

/**
 * Из инлайнового style оставляет ТОЛЬКО объявление цвета с безопасным значением
 * (hex / rgb(a) / именованный цвет). Нужно, чтобы сохранить подсветку кода, снятую
 * со страницы ChatGPT, не пропуская произвольный CSS. Возвращает "color:..." или ''.
 * @param {string} value
 * @returns {string}
 */
function safeColorStyle(value) {
  if (!value) return '';
  const out = [];
  const re = /(?:^|;)\s*(color|background-color)\s*:\s*([^;!{}]+)/gi;
  let m;
  while ((m = re.exec(value)) !== null) {
    const prop = m[1].toLowerCase();
    const c = m[2].trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(c) ||
        /^rgba?\(\s*[\d.,\s%]+\)$/.test(c) ||
        /^[a-zA-Z]+$/.test(c)) {
      out.push(prop + ':' + c);
    }
  }
  return out.join(';');
}

/**
 * Снимает все обработчики on* с узла (защита в том числе узлов формул MathML).
 * @param {Element} el
 */
function stripEventAttrs(el) {
  Array.from(el.attributes || []).forEach((attr) => {
    if (attr.name.toLowerCase().startsWith('on')) {
      el.removeAttribute(attr.name);
    }
  });
}

/**
 * Разворачивает элемент: его содержимое остаётся на месте, сама обёртка исчезает.
 * @param {Element} el
 */
function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) {
    el.remove();
    return;
  }
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
}

/**
 * Рекурсивно чистит поддерево по белому списку: опасные теги удаляет, неизвестные
 * разворачивает (сохраняя текст), у разрешённых оставляет только безопасные атрибуты,
 * у ссылок и картинок проверяет протокол. Узлы формул MathML пропускает по составу.
 * @param {Element} el
 */
function sanitizeElement(el) {
  // Сначала дети (снимок списка, потому что дерево меняется по ходу).
  Array.from(el.childNodes).forEach((child) => {
    if (child.nodeType === 1) {
      sanitizeElement(child);
    }
  });

  // Узлы формул MathML не трогаем по составу, только снимаем обработчики событий.
  if (el.namespaceURI === MATHML_NS) {
    stripEventAttrs(el);
    return;
  }

  const tag = el.tagName ? el.tagName.toUpperCase() : '';

  if (DROP_TAGS.has(tag)) {
    el.remove();
    return;
  }

  // Кнопки интерфейса ChatGPT. Кнопку, ОБЁРНУТУЮ вокруг картинки чата (клик-зум),
  // разворачиваем — иначе потеряем <img> (баг 2026-07-07, из-за него BUTTON и убрали
  // из DROP_TAGS). Но кнопка БЕЗ картинки полезного содержимого не несёт, а её подпись
  // протекала в документ отдельной строкой («Edit» у канваса ChatGPT) — такую удаляем
  // целиком вместе с текстом.
  if (isButtonEl(el)) {
    if (buttonWrapsImage(el)) { unwrap(el); }
    else { el.remove(); }
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    unwrap(el); // неизвестная обёртка: убираем её, но оставляем содержимое
    return;
  }

  // Разрешённый тег: оставляем только класс и явно разрешённые для тега атрибуты.
  const allowed = ALLOWED_ATTRS[tag];
  Array.from(el.attributes || []).forEach((attr) => {
    const name = attr.name.toLowerCase();
    if (name === 'class' || (allowed && allowed.has(name))) {
      return;
    }
    if (name === 'style') {
      // Пропускаем ТОЛЬКО безопасный цвет (для сохранённой подсветки кода), остальное режем.
      const safe = safeColorStyle(attr.value);
      if (safe) { el.setAttribute('style', safe); }
      else { el.removeAttribute(attr.name); }
      return;
    }
    el.removeAttribute(attr.name);
  });

  if (tag === 'A') {
    if (!isSafeUrl(el.getAttribute('href'))) {
      el.removeAttribute('href');
    }
    el.setAttribute('rel', 'noopener noreferrer');
    el.removeAttribute('target');
  }

  if (tag === 'IMG' && !isSafeUrl(el.getAttribute('src'))) {
    el.remove();
  }
}

/**
 * Готовит разметку одного сообщения к печати: заменяет формулы KaTeX на чистый MathML
 * и чистит остальное по белому списку тегов и атрибутов.
 * Почему белый список, а не чёрный: страница печати - привилегированная страница
 * расширения, поэтому безопаснее разрешать только заведомо безопасное, чем пытаться
 * перечислить всё опасное.
 * @param {string} rawHtml - исходная разметка одного сообщения
 * @returns {string} очищенная разметка
 */
function cleanMessageHtml(rawHtml) {
  try {
    if (typeof rawHtml !== 'string' || rawHtml.length === 0) {
      return '';
    }

    // В Node (тесты) DOMParser отсутствует - разбор в браузере закрывает стенд,
    // здесь просто возвращаем вход без изменений, чтобы не падать при импорте.
    if (typeof DOMParser === 'undefined') {
      return rawHtml;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString('<div id="cgpt-root">' + rawHtml + '</div>', 'text/html');
    const root = doc.getElementById('cgpt-root');
    if (!root) {
      return '';
    }

    // Формулы KaTeX заменяем на MathML раньше остальной чистки, пока узлы целы.
    // Выключную (крупную, на отдельной строке) формулу отличаем от строчной, чтобы
    // строчная формула оставалась внутри предложения, а не разрывала его на строки.
    root.querySelectorAll('.katex').forEach((katexEl) => {
      const isDisplay = !!(katexEl.closest && katexEl.closest('.katex-display'));
      const wrapper = doc.createElement('span');
      wrapper.className = isDisplay ? 'cgpt-math cgpt-math-display' : 'cgpt-math';
      wrapper.innerHTML = mathmlFromKatex(katexEl);
      // Для выключной формулы сохраняем TeX-исходник: если формула окажется шире
      // листа и не влезет читаемым масштабом, print.js перенесёт её как текст.
      if (isDisplay) {
        const ann = katexEl.querySelector('annotation[encoding="application/x-tex"]');
        if (ann && ann.textContent) {
          wrapper.setAttribute('data-tex', ann.textContent.trim());
        }
      }
      katexEl.replaceWith(wrapper);
    });

    // Чистим по белому списку сверху вниз (снимок, дерево меняется по ходу).
    Array.from(root.childNodes).forEach((child) => {
      if (child.nodeType === 1) {
        sanitizeElement(child);
      }
    });

    return root.innerHTML;
  } catch (err) {
    console.error('CGPT: cleanMessageHtml не смог очистить сообщение', err);
    return ''; // при сбое лучше пусто, чем неочищенная разметка на привилегированной странице
  }
}

/**
 * Убирает повторы сообщений по id (оставляет первое вхождение) и сортирует
 * по order по возрастанию. Почему нужно: сбор идёт прокруткой, один и тот же
 * узел может попасть в поле зрения несколько раз.
 * @param {Array<{id:string, order:number, role:string, html:string}>} items
 * @returns {Array<{id:string, order:number, role:string, html:string}>}
 */
function dedupeOrdered(items) {
  try {
    if (!Array.isArray(items)) {
      return [];
    }

    const seen = new Set();
    const result = [];
    for (const item of items) {
      if (!item || seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      result.push(item);
    }

    result.sort((a, b) => a.order - b.order);
    return result;
  } catch (err) {
    console.error('CGPT: dedupeOrdered упал на входных данных', err);
    return [];
  }
}

/**
 * Экранирует текст для безопасной вставки в HTML (заголовок разговора, подписи).
 * @param {string} s - произвольный текст
 * @returns {string} экранированная строка, пустая строка для пустого/undefined входа
 */
function escapeText(s) {
  try {
    if (s === undefined || s === null || s === '') {
      return '';
    }
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  } catch (err) {
    console.error('CGPT: escapeText не смог экранировать строку', err);
    return '';
  }
}

/**
 * Самопроверка результата сбора: по фактам сбора решает, всё ли в порядке, и если
 * нет - выдаёт понятную пользователю причину (на английском, продукт для US/EU).
 * Чистая функция без DOM - специально, чтобы её можно было покрыть тестами.
 * @param {{rawCount:number, cleanedCount:number, strategy:string}} stats
 *   rawCount - сколько узлов сообщений собрано; cleanedCount - сколько осталось
 *   непустых после очистки; strategy - каким селектором нашлись сообщения
 *   ('role' - основной, 'turn'/'article' - запасные, 'none' - не нашлись).
 * @returns {{ok:boolean, code:string, message:string, warn:string}}
 */
function collectionVerdict(stats) {
  const s = stats || {};
  const raw = Number(s.rawCount) || 0;
  const cleaned = Number(s.cleanedCount) || 0;
  const strategy = s.strategy || 'none';

  if (raw === 0) {
    return {
      ok: false,
      code: 'no-messages',
      message: 'Could not find any messages on this page. Open a ChatGPT conversation and reload the page. '
        + 'If this keeps happening, ChatGPT may have changed its layout and the extension needs an update.',
      warn: 'CGPT self-check: сообщения не найдены ни одним селектором - вероятно, изменилась вёрстка ChatGPT.',
    };
  }

  if (cleaned === 0) {
    return {
      ok: false,
      code: 'empty-content',
      message: 'Found the conversation but could not read its text. Reload the ChatGPT page and try again.',
      warn: 'CGPT self-check: узлы сообщений найдены, но после очистки контент пуст.',
    };
  }

  const verdict = { ok: true, code: 'ok', message: '', warn: '' };
  // Ранний сигнал дрейфа вёрстки: основной селектор не сработал, спас запасной.
  if (strategy !== 'role') {
    verdict.warn = 'CGPT self-check: основной селектор сообщений не сработал, использован запасной ("'
      + strategy + '"). Возможен скорый слом сбора - стоит обновить селекторы в dom-scan.js.';
  }
  return verdict;
}

/**
 * Ставит сообщения в порядок разговора по номеру хода (data-testid="conversation-turn-N").
 * Зачем: порядок сбора («когда сообщение попалось при прокрутке») врёт - из-за виртуализации
 * часть ходов не смонтирована, они попадаются позже и уезжают в конец документа
 * (баг 2026-07-11). Номер хода - настоящий порядок в чате.
 *
 * Осторожно: перестраиваем ТОЛЬКО если номер хода известен у ВСЕХ сообщений. Если ChatGPT
 * сменит разметку и номера пропадут хотя бы у части - молча смешивать две разные шкалы
 * нельзя, это перетасует документ. В таком случае оставляем порядок сбора как есть.
 * @param {Array<{order:number, turn:(number|null|undefined)}>} items
 * @returns {Array} те же элементы с проставленным order
 */
function orderByTurn(items) {
  try {
    if (!Array.isArray(items) || items.length === 0) {
      return Array.isArray(items) ? items : [];
    }
    const allKnown = items.every((it) => it && Number.isFinite(it.turn));
    if (!allKnown) {
      return items;
    }
    // Один ход = один узел сообщения, но подстрахуемся: при равных номерах
    // сохраняем порядок сбора.
    const sorted = items.slice().sort((a, b) => (a.turn - b.turn) || (a.order - b.order));
    return sorted.map((it, i) => Object.assign({}, it, { order: i }));
  } catch (err) {
    console.error('CGPT: orderByTurn не смог упорядочить сообщения', err);
    return items;
  }
}

/**
 * Выбрасывает сообщения-картинки, которые повторяют уже показанную картинку.
 * Зачем: генерацию картинки ChatGPT рендерит НЕСКОЛЬКИМИ сообщениями (промежуточные
 * превью + финал). У каждого свой data-message-id, поэтому отпечаток их не склеивает,
 * и в PDF одна картинка выходила четырьмя подряд (баг 2026-07-11).
 *
 * Удаляем ТОЛЬКО сообщение, в котором нет ничего, кроме картинок (текста нет) и все его
 * картинки уже встречались выше. Сообщение с текстом не трогаем никогда - там картинка
 * часть смысла, а не дубль превью.
 * @param {Array<{html:string}>} items
 * @param {(src:string)=>string} keyOf - ключ картинки (CGPT_DOM.imgFileKey)
 * @returns {Array}
 */
/**
 * Сколько картинок в куске HTML. Отдельная функция, потому что по этому числу решается,
 * стоит ли перезахватывать уже собранное сообщение.
 * @param {string} html
 * @returns {number}
 */
function countImgs(html) {
  return ((html || '').match(/<img/gi) || []).length;
}

/**
 * Выбирает, какой из двух снимков одного и того же сообщения оставить.
 *
 * БАГ #86, вторая половина: сбор идёт прокруткой и запоминает сообщение ОДИН РАЗ, при
 * первой встрече. ChatGPT рисует текст ответа сразу, а блок со сгенерированной картинкой
 * подмонтирует позже. Если сообщение попалось в этот промежуток, в память ложится вариант
 * БЕЗ картинки и больше никогда не обновляется: картинка не доезжает до документа, хотя
 * на странице она есть. Снаружи это выглядит как "через браузер печатается, через
 * расширение нет".
 *
 * Обновляем запись, только если картинок стало БОЛЬШЕ. Текст не трогаем: перезахват
 * ради текста вернул бы старые беды с плавающей раскладкой и дублями.
 * @param {string} prevHtml - что уже собрано
 * @param {string} nextHtml - что видно сейчас
 * @returns {string} снимок, который оставляем
 */
function pickRicherHtml(prevHtml, nextHtml) {
  try {
    if (typeof nextHtml !== 'string' || nextHtml.length === 0) {
      return prevHtml;
    }
    return countImgs(nextHtml) > countImgs(prevHtml) ? nextHtml : prevHtml;
  } catch (err) {
    return prevHtml;
  }
}

function dropDuplicateImageMessages(items, keyOf) {
  try {
    if (!Array.isArray(items) || typeof keyOf !== 'function') {
      return Array.isArray(items) ? items : [];
    }
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const html = (item && item.html) || '';
      const keys = [];
      const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        keys.push(keyOf(m[1]));
      }
      const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
      const imageOnly = keys.length > 0 && text.length === 0;

      if (imageOnly && keys.every((k) => seen.has(k))) {
        continue; // то же самое превью ещё раз - в документ не пускаем
      }
      keys.forEach((k) => seen.add(k));
      out.push(item);
    }
    return out;
  } catch (err) {
    console.error('CGPT: dropDuplicateImageMessages упал, оставляем как есть', err);
    return items;
  }
}

/**
 * Пропущенные номера ходов: чего не хватает между самым первым и самым последним
 * собранным ходом. Это ЕДИНСТВЕННАЯ честная проверка полноты сбора - число собранного
 * ("счётчик перестал расти") ею не является.
 *
 * История: сбор останавливался, когда счётчик переставал расти. Пока одна картинка
 * плодила четыре разных отпечатка, счётчик рос и цикл крутился дольше - и этим случайно
 * добирал ходы, не смонтированные из-за виртуализации. Как только картинка схлопнулась
 * (0.7.12), цикл стал выходить раньше и ТРИ сообщения (вопрос про прайсинг, вопрос про
 * код и сам код) не попали в PDF. Дыра была всегда - её просто маскировал дубль.
 * @param {Array<{turn:(number|null|undefined)}>} items
 * @returns {number[]} пропущенные номера ходов (пусто, если всё на месте или номеров нет)
 */
function missingTurns(items) {
  try {
    if (!Array.isArray(items) || items.length === 0) {
      return [];
    }
    const turns = items.map((it) => (it ? it.turn : null)).filter((t) => Number.isFinite(t));
    if (turns.length === 0) {
      return []; // разметки ходов нет - судить не по чему, не выдумываем тревогу
    }
    const have = new Set(turns);
    const min = Math.min.apply(null, turns);
    const max = Math.max.apply(null, turns);
    const gaps = [];
    for (let t = min; t <= max; t++) {
      if (!have.has(t)) {
        gaps.push(t);
      }
    }
    return gaps;
  } catch (err) {
    console.error('CGPT: missingTurns упал', err);
    return [];
  }
}

/**
 * Различает ДВЕ РАЗНЫЕ БЕДЫ, которые до 10.09.2026 приходили под одним именем `turns`.
 *
 * Дыра в номерах ходов сама по себе ничего не доказывает. Она значит одно из двух:
 *  1) ход ЕСТЬ на странице, но мы его не собрали - это наша поломка (столкновение
 *     отпечатков, промах прохода по ленте, неподхваченная разметка);
 *  2) хода с таким номером на странице НЕТ вовсе - тогда терять было нечего, а нумерация
 *     ChatGPT просто не сплошная. Так бывает после правки сообщения или перегенерации
 *     ответа: ветка разговора меняется, номера остаются от прежней.
 *
 * Первое надо чинить, второе - не трогать, иначе будем месяцами гоняться за призраком.
 * Решает наличие узла с таким номером в разметке ПОСЛЕ всех проходов сбора.
 * @param {number[]} gaps - недостающие номера ходов
 * @param {number[]} presentNumbers - номера ходов, реально размеченные на странице
 * @returns {{kind: string, inDom: number[]}} kind: 'turns' (наша потеря) | 'turns_absent'
 */
function classifyMissingTurns(gaps, presentNumbers) {
  try {
    const list = Array.isArray(gaps) ? gaps.filter((n) => Number.isFinite(n)) : [];
    if (list.length === 0) {
      return { kind: 'turns_absent', inDom: [] };
    }
    const present = new Set((Array.isArray(presentNumbers) ? presentNumbers : [])
      .filter((n) => Number.isFinite(n)));
    const inDom = list.filter((n) => present.has(n));
    return { kind: inDom.length > 0 ? 'turns' : 'turns_absent', inDom };
  } catch (err) {
    console.error('CGPT: classifyMissingTurns упал', err);
    return { kind: 'turns', inDom: [] };   // при сбое считаем бедой нашей: лучше проверить лишний раз
  }
}

const CGPT_LIB = {
  mathmlFromKatex,
  orderByTurn,
  missingTurns,
  classifyMissingTurns,
  dropDuplicateImageMessages,
  countImgs,
  pickRicherHtml,
  cleanMessageHtml,
  dedupeOrdered,
  escapeText,
  collectionVerdict,
  isButtonEl,
  buttonWrapsImage,
};

// Двойной режим: модуль Node для тестов и глобальный объект для браузера.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CGPT_LIB;
}
if (typeof globalThis !== 'undefined') {
  globalThis.CGPT = CGPT_LIB;
}
