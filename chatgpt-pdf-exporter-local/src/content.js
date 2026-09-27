/*
 * content.js - живёт на странице ChatGPT: по команде из попапа (через background)
 * собирает весь разговор прокруткой, шлёт ход сбора в попап и открывает окно печати.
 * Кнопки на самой странице нет: запуск идёт из окна расширения (попапа).
 * Опирается на lib.js и dom-scan.js (подключены раньше в manifest.json), поэтому
 * использует функции через globalThis.CGPT и globalThis.CGPT_DOM.
 */

(function () {
  'use strict';

  const ERROR_BADGE_ID = 'cgpt-save-pdf-error';
  const SCROLL_PAUSE_MS = 350;
  const STABLE_ROUNDS_NEEDED = 2; // запас проходов после того, как число сообщений перестало расти
  const REHARVEST_PASSES = 3;     // сколько раз пройти ленту заново, если в номерах ходов дыры
  const MAX_STEPS_PER_PASS = 400; // предохранитель от вечного цикла на очень длинном чате
  // Ожидание появления картинок перед финальной пересборкой html (#86). Замер 2026-09-07
  // на живом ChatGPT: узлы сообщений появляются на ~1.0 с после открытия чата, блок
  // картинки на холодной загрузке - на ~2.6 с. 4 секунды с запасом; ждём только появления
  // в разметке, не декодирования, поэтому обычно выходим за 300 мс.
  const SETTLE_IMAGES_TIMEOUT_MS = 4000;
  const SETTLE_IMAGES_STEP_MS = 150;

  /**
   * Показывает плашку ошибки в углу страницы - запасная подсказка, если окно
   * расширения уже закрыто, чтобы ошибка никогда не была молчаливой.
   * @param {string} text
   */
  function showErrorBadge(text) {
    try {
      const old = document.getElementById(ERROR_BADGE_ID);
      if (old) {
        old.remove();
      }

      const badge = document.createElement('div');
      badge.id = ERROR_BADGE_ID;
      Object.assign(badge.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',
        maxWidth: '320px',
        padding: '12px 36px 12px 14px',
        background: '#fff3f3',
        border: '1px solid #e33',
        borderRadius: '8px',
        color: '#a11',
        fontSize: '13px',
        fontFamily: 'sans-serif',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      });
      badge.textContent = text;

      const closeBtn = document.createElement('span');
      closeBtn.textContent = '✕';
      Object.assign(closeBtn.style, {
        position: 'absolute',
        top: '6px',
        right: '10px',
        cursor: 'pointer',
        fontWeight: 'bold',
      });
      closeBtn.addEventListener('click', () => badge.remove());

      badge.appendChild(closeBtn);
      document.body.appendChild(badge);
    } catch (err) {
      console.error('CGPT: не удалось показать плашку ошибки', err);
    }
  }

  /**
   * Сообщает об ошибке: основное сообщение в окно расширения, плюс запасная плашка
   * на странице на случай, если окно расширения уже закрыто.
   * @param {string} text
   */
  function reportError(text) {
    chrome.runtime.sendMessage({ type: 'CGPT_ERROR', message: text }).catch(() => {});
    showErrorBadge(text);
  }

  /**
   * Пауза на указанное число миллисекунд.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Собирает разговор прокруткой: листает контейнер сверху вниз, на каждом шаге
   * складывает видимые сообщения в Map по устойчивому id, ждёт стабилизации
   * числа найденных сообщений перед остановкой.
   * @param {(count:number)=>void} onProgress - сообщить текущее число собранного
   * @returns {Promise<Array<{id:string, order:number, role:string, html:string}>>}
   */
  async function collectByScrolling(onProgress) {
    const dom = globalThis.CGPT_DOM;
    const collected = new Map();
    let orderCounter = 0;
    let stableRounds = 0;
    let lastCount = -1;
    let done = false;

    const initialNodes = dom.findMessageNodes();
    const container = dom.findScrollContainer(initialNodes[0] || null);
    const isWindowContainer = container === window;

    // Возвращаемся в самый верх разговора перед стартом сбора.
    if (isWindowContainer) {
      window.scrollTo(0, 0);
    } else {
      container.scrollTop = 0;
    }
    await sleep(SCROLL_PAUSE_MS);

    // Шаг меньше экрана: ChatGPT выгружает из DOM то, что далеко от вьюпорта
    // (виртуализация). При шаге в целый экран ход мог ни разу не оказаться смонтированным
    // и не попасть в документ. С перекрытием каждый ход гарантированно проходит через вьюпорт.
    const stepSize = Math.max(200, Math.round((window.innerHeight || 800) * 0.6));

    /**
     * Ждёт, пока контентные картинки собранных ходов ПОЯВЯТСЯ в разметке. Выходит, как
     * только их число перестало расти, либо по таймауту - печать важнее полноты.
     *
     * Декодирования (naturalWidth > 0) НЕ ждём. Замер на живом ChatGPT 2026-09-07: у
     * видимой на экране картинки naturalWidth оставался нулём и через 10 секунд, загрузка
     * у них ленивая. Как признак готовности это не годится, да и не нужно: встраивание
     * качает картинку заново по адресу через fetch, а не берёт пиксели из DOM.
     * @param {Map<string, {node?: Element}>} collectedMap
     * @param {object} domApi
     * @returns {Promise<void>}
     */
    const settleContentImages = async (collectedMap, domApi) => {
      const countContentImgs = () => {
        let count = 0;
        for (const it of collectedMap.values()) {
          if (!it.node) continue;
          const scope = domApi.imageScopeOfNode ? domApi.imageScopeOfNode(it.node) : it.node;
          scope.querySelectorAll('img').forEach((im) => {
            const s = im.getAttribute('src') || im.currentSrc || '';
            if (domApi.isContentImg(s)) count++;
          });
        }
        return count;
      };
      // Разговор без картинок вообще - ждать нечего, не задерживаем текстовый экспорт.
      // Блок картинки ChatGPT размечает как <div id="image-...">, он появляется вместе с
      // самой картинкой и служит признаком «здесь картинка будет».
      if (countContentImgs() === 0 && !document.querySelector('[id^="image-"]')) {
        return;
      }
      const deadline = Date.now() + SETTLE_IMAGES_TIMEOUT_MS;
      let lastCount = -1, stable = 0;
      while (Date.now() < deadline) {
        const count = countContentImgs();
        if (count > 0 && count === lastCount) {
          stable++;
          if (stable >= 2) return;
        } else {
          stable = 0;
          lastCount = count;
        }
        await sleep(SETTLE_IMAGES_STEP_MS);
      }
    };

    const harvest = () => {
      dom.findMessageNodes().forEach((node) => {
        const role = dom.roleOfNode(node);
        const id = dom.idOfNode(node, role);
        const prev = collected.get(id);
        if (!prev) {
          collected.set(id, {
            id,
            order: orderCounter++,             // запасной порядок: когда сообщение попалось
            turn: dom.turnIndexOfNode(node),   // настоящий порядок: номер хода в чате
            role,
            node,                              // ссылка на узел: html пересоберём в конце,
            html: dom.htmlOfNode(node),        //   когда догрузятся картинки (#86)
          });
        } else {
          // Сообщение уже собрано, но картинка могла подмонтироваться ПОСЛЕ первой встречи
          // (#86): ChatGPT рисует текст сразу, блок картинки догружает. Обновляем снимок,
          // только если картинок стало больше - см. pickRicherHtml.
          prev.node = node;
          prev.html = window.CGPT.pickRicherHtml(prev.html, dom.htmlOfNode(node));
        }
      });
      onProgress(collected.size);
    };

    // Условие остановки: дошли до низа И число собранного не растёт несколько проходов подряд.
    while (!done) {
      harvest();

      const scrollTop = isWindowContainer ? window.scrollY : container.scrollTop;
      const scrollHeight = isWindowContainer ? document.documentElement.scrollHeight : container.scrollHeight;
      const clientHeight = isWindowContainer ? window.innerHeight : container.clientHeight;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 4;

      stableRounds = collected.size === lastCount ? stableRounds + 1 : 0;
      lastCount = collected.size;

      if (atBottom && stableRounds >= STABLE_ROUNDS_NEEDED) {
        done = true;
        break;
      }

      if (isWindowContainer) {
        window.scrollBy(0, stepSize);
      } else {
        container.scrollTop += stepSize;
      }
      await sleep(SCROLL_PAUSE_MS);
    }

    // Добор по ДЫРКАМ в номерах ходов. Остановка «счётчик перестал расти» полноту не
    // доказывает: ход, не смонтированный из-за виртуализации, счётчик не увеличит - и мы
    // спокойно выйдем без него (баг 2026-07-11: пропали вопрос про код и сам код).
    // Пока в номерах ходов есть дыры - проходим ленту заново, сверху вниз.
    for (let pass = 0; pass < REHARVEST_PASSES; pass++) {
      const gaps = window.CGPT.missingTurns(Array.from(collected.values()));
      if (gaps.length === 0) {
        break;
      }
      console.warn('CGPT: не хватает ходов, иду за ними ещё раз:', gaps);

      if (isWindowContainer) {
        window.scrollTo(0, 0);
      } else {
        container.scrollTop = 0;
      }
      await sleep(SCROLL_PAUSE_MS);

      let guard = 0;
      while (guard++ < MAX_STEPS_PER_PASS) {
        harvest();
        const scrollTop = isWindowContainer ? window.scrollY : container.scrollTop;
        const scrollHeight = isWindowContainer ? document.documentElement.scrollHeight : container.scrollHeight;
        const clientHeight = isWindowContainer ? window.innerHeight : container.clientHeight;
        if (scrollTop + clientHeight >= scrollHeight - 4) {
          break;
        }
        if (isWindowContainer) {
          window.scrollBy(0, stepSize);
        } else {
          container.scrollTop += stepSize;
        }
        await sleep(SCROLL_PAUSE_MS);
      }
    }

    // ФИНАЛЬНАЯ ПЕРЕСБОРКА (#86). Замер на живом ChatGPT 2026-09-07: узлы сообщений
    // появляются в разметке на ~1.0 с после открытия чата, а блок сгенерированной картинки
    // только на ~2.6 с. Короткий чат собирается примерно за секунду - то есть снимок
    // сообщения успевал сложиться БЕЗ картинки и больше не обновлялся. Снаружи это и была
    // жалоба «через браузер печатается, а через расширение картинки нет».
    // Поэтому в конце ждём, пока контентные картинки догрузятся, и пересобираем html.
    await settleContentImages(collected, dom);
    for (const it of collected.values()) {
      if (!it.node) continue;
      try { it.html = window.CGPT.pickRicherHtml(it.html, dom.htmlOfNode(it.node)); }
      catch (err) { /* оставляем прежний снимок */ }
    }

    // Дыры в номерах ходов остались. Молчать нельзя (канарейка #22), но и кричать «потеря»
    // рано: дыра значит либо нашу поломку, либо несплошную нумерацию самого ChatGPT после
    // правки сообщения или перегенерации ответа. Решает наличие узла с этим номером на
    // странице после всех проходов - см. classifyMissingTurns (#93, разбор 10.09.2026).
    const leftover = window.CGPT.missingTurns(Array.from(collected.values()));
    if (leftover.length > 0 && globalThis.CGPT_EVENTS) {
      const present = dom.presentTurnNumbers ? dom.presentTurnNumbers() : [];
      const verdict = window.CGPT.classifyMissingTurns(leftover, present);
      if (verdict.kind === 'turns') {
        console.warn('CGPT: ходы есть на странице, но не собрались:', verdict.inDom);
      } else {
        console.warn('CGPT: номера ходов не сплошные, самих ходов на странице нет:', leftover);
      }
      globalThis.CGPT_EVENTS.track('content_dropped', {
        dropped: verdict.kind,            // 'turns' - наша потеря; 'turns_absent' - дырка в нумерации
        reason: 'missing_turns',
        messages: verdict.kind === 'turns' ? verdict.inDom.length : leftover.length,
      });
    }

    return window.CGPT.orderByTurn(Array.from(collected.values()));
  }

  // Потолок числа встраиваемых картинок. Был 30 и молча выбрасывал всё сверх лимита (#86).
  // После ужатия (SHRINK_OVER_BYTES ниже) картинка весит порядка 0.5 МБ вместо 2 МБ, поэтому
  // потолок поднят вдвое. Настоящую защиту даёт лимит по суммарному весу, а не по числу.
  const MAX_INLINE_IMAGES = 60;
  const MAX_TOTAL_INLINE_BYTES = 40 * 1024 * 1024; // общий вес встроенного за один экспорт
  const MAX_IMG_BYTES = 4 * 1024 * 1024;   // 4 МБ на картинку
  const SHRINK_OVER_BYTES = 400 * 1024;    // тяжелее - ужимаем перед встраиванием (#86)
  const PRINT_MAX_EDGE = 1600;             // пикселей по длинной стороне: для A4 с запасом
  const PRINT_JPEG_QUALITY = 0.9;

  /**
   * Превращает blob в data-URL как есть.
   * @param {Blob} blob
   * @returns {Promise<string|null>}
   */
  function blobToDataURL(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Ужимает картинку перед встраиванием: масштабирует до PRINT_MAX_EDGE по длинной стороне
   * и перекодирует в JPEG.
   *
   * ЗАЧЕМ (#86, замер 2026-09-07): картинка доезжала до страницы печати, была встроена и
   * отрисована на экране, но в предпросмотре печати и в PDF её не было. Предпросмотр Chrome
   * рендерит документ заново в отдельном процессе, и картинка, вшитая как data-URL на 2 МБ
   * (это ~2.7 МБ base64 в атрибуте), до него не доезжает. Уменьшённая доезжает.
   * Для листа A4 при 15 мм полей 1600 пикселей по длинной стороне - с запасом.
   *
   * Прозрачность заливаем белым: бумага белая, а JPEG альфу не хранит.
   * @param {Blob} blob
   * @returns {Promise<string|null>} data-URL или null, если ужать не вышло
   */
  async function shrinkForPrint(blob) {
    try {
      if (typeof createImageBitmap !== 'function') return null;
      const bmp = await createImageBitmap(blob);
      const longEdge = Math.max(bmp.width, bmp.height);
      const scale = longEdge > PRINT_MAX_EDGE ? PRINT_MAX_EDGE / longEdge : 1;
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      if (typeof bmp.close === 'function') bmp.close();
      const out = canvas.toDataURL('image/jpeg', PRINT_JPEG_QUALITY);
      return typeof out === 'string' && out.indexOf('data:image') === 0 ? out : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Скачивает картинку (тот же origin chatgpt.com, с куками) и превращает в data-URL,
   * чтобы она открылась на странице печати без авторизации. Тяжёлую предварительно ужимает.
   * null при неудаче или превышении MAX_IMG_BYTES.
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  async function fetchAsDataURL(url) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!blob || blob.size === 0 || blob.size > MAX_IMG_BYTES) return null;
      // Тяжёлую картинку ужимаем: иначе предпросмотр печати Chrome теряет её целиком.
      if (blob.size > SHRINK_OVER_BYTES) {
        const small = await shrinkForPrint(blob);
        if (small) return small;
        // Ужать не вышло (нет createImageBitmap, битый файл) - встраиваем как есть:
        // лучше рискнуть предпросмотром, чем потерять картинку наверняка.
      }
      return await blobToDataURL(blob);
    } catch (err) {
      return null;
    }
  }

  /**
   * Встраивает картинки одного сообщения как data-URL. Если инлайн не удался,
   * оставляет исходный URL (страница печати отрисует картинку напрямую через <img>).
   * @param {string} html
   * @param {{count:number, bytes:number, dropped:number}} budget - общий бюджет экспорта
   * @returns {Promise<string>}
   */
  async function inlineImagesInHtml(html, budget) {
    if (!html || html.indexOf('<img') === -1) return html;
    const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    const root = doc.getElementById('r');
    if (!root) return html;
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const src = img.getAttribute('src') || '';
      if (!src || src.indexOf('data:') === 0) continue;
      // Упёрлись в потолок. РАНЬШЕ ЗДЕСЬ КАРТИНКУ УДАЛЯЛИ - и она пропадала из PDF совсем
      // (до 09.09 ещё и молча, #86). Это ничем не оправдано: двумя строками ниже уже есть
      // бережная развилка на случай, когда встроить не удалось, - картинка остаётся обычной
      // ссылкой, и страница печати отрисует её сама. Теперь то же самое и на потолке.
      //
      // Потолок задуман как защита от ВЕСА (base64 раздувает документ примерно на треть, и
      // на сотне картинок диалог печати перестаёт справляться), а не как уничтожитель
      // содержимого. Событие images_capped продолжаем слать: оно говорит, как часто мы в
      // потолок упираемся, но больше НЕ означает «у человека пропали картинки» (#93).
      if (budget.count >= MAX_INLINE_IMAGES || budget.bytes >= MAX_TOTAL_INLINE_BYTES) {
        budget.dropped++;
        continue;   // оставляем исходный src - картинка доедет по ссылке
      }
      budget.count++;
      const dataUrl = await fetchAsDataURL(src);
      // Если инлайн не удался (хост без разрешения, срок подписи, размер) - НЕ выкидываем
      // картинку: оставляем исходный URL. Страница печати всё равно отрисует её через <img>
      // (показ картинки не ограничен CORS), так что изображение не теряется.
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
        budget.bytes += dataUrl.length;
      }
    }
    return root.innerHTML;
  }

  /**
   * Инлайнит картинки во всех сообщениях с общим бюджетом на число и вес.
   * Если из-за потолка что-то выброшено - говорит об этом вслух: в консоль и в аналитику.
   * Молчаливых потерь у нас больше нет (#86).
   * @param {Array<{role:string, html:string}>} messages
   */
  async function inlineAllImages(messages) {
    const budget = { count: 0, bytes: 0, dropped: 0 };
    for (const m of messages) {
      m.html = await inlineImagesInHtml(m.html, budget);
    }
    if (budget.dropped > 0) {
      console.warn('CGPT: картинок не встроено по потолку экспорта:', budget.dropped,
        '- они остались ссылками и будут загружены страницей печати',
        '(встроено ' + budget.count + ', вес ' + Math.round(budget.bytes / 1024) + ' КБ)');
      if (globalThis.CGPT_EVENTS) {
        globalThis.CGPT_EVENTS.track('content_dropped', {
          dropped: 'images_capped',   // отдельно от 'images': это ЧАСТИЧНАЯ потеря, а не полная
          images: budget.dropped,
        });
      }
    }
  }

  /**
   * Канарейка содержимого (#22): сравнивает, какие типы контента (картинки/код/таблицы)
   * есть на странице и сколько дошло до готового HTML. Если тип ПОЛНОСТЬЮ пропал -
   * шлёт анонимное событие content_dropped в аналитику. Это ловит поломки ниже сбора
   * (смена хоста картинок, срез санитайзером - как 2026-07-07), причём в реальном
   * браузере реального пользователя, без сервера и логина. Никогда не мешает экспорту.
   * @param {Array<{role:string, html:string}>} items - готовые сообщения
   */
  function contentCanary(items) {
    try {
      const ev = globalThis.CGPT_EVENTS, dom = globalThis.CGPT_DOM;
      if (!ev || !dom || !dom.findMessageNodes) return;
      const nodes = dom.findMessageNodes();
      let pageImg = 0, pageCode = 0, pageTable = 0;
      // Картинки считаем по ОБЛАСТИ ХОДА, а не по узлу сообщения. Иначе (замер 2026-09-07,
      // #86) сгенерированная картинка, которая лежит в ветке-соседе, не попадает в счётчик:
      // «на странице» выходит ноль, условие тревоги pageImg > 0 не выполняется НИКОГДА,
      // и канарейка молчит именно в том случае, ради которого написана.
      const imgScopes = new Set();
      for (const n of nodes) {
        imgScopes.add(dom.imageScopeOfNode ? dom.imageScopeOfNode(n) : n);
      }
      for (const scope of imgScopes) {
        scope.querySelectorAll('img').forEach((im) => {
          const s = im.getAttribute('src') || im.currentSrc || '';
          if (/^https?:/.test(s) && (im.naturalWidth > 64 || im.clientWidth > 64)) pageImg++;
        });
      }
      for (const n of nodes) {
        if (n.querySelector('pre, code')) pageCode++;
        if (n.querySelector('table')) pageTable++;
      }
      let outImg = 0, outCode = 0, outTable = 0;
      for (const m of (items || [])) {
        const h = (m && m.html) || '';
        outImg += (h.match(/<img/gi) || []).length;
        if (/<pre|<code/i.test(h)) outCode++;
        if (/<table/i.test(h)) outTable++;
      }
      // Тревога только на ПОЛНУЮ пропажу - дедуп/варианты рендера не дают ложных срабатываний.
      if (pageImg > 0 && outImg === 0) ev.track('content_dropped', { dropped: 'images', images: pageImg });
      if (pageCode > 0 && outCode === 0) ev.track('content_dropped', { dropped: 'code' });
      if (pageTable > 0 && outTable === 0) ev.track('content_dropped', { dropped: 'tables' });
    } catch (err) {
      try { console.warn('CGPT: канарейка содержимого дала сбой', err); } catch (e) { /* молча */ }
    }
  }

  /**
   * Полный сценарий сбора и открытия печати. Запускается по команде CGPT_EXPORT.
   */
  async function runExport() {
    const t0 = Date.now();
    try {
      const rawItems = await collectByScrolling((count) => {
        chrome.runtime.sendMessage({ type: 'CGPT_PROGRESS', count }).catch(() => {});
      });

      const ordered = window.CGPT.dropDuplicateImageMessages(
        window.CGPT.dedupeOrdered(rawItems),
        globalThis.CGPT_DOM.imgFileKey,
      );

      const cleaned = ordered.map((item) => ({
        role: item.role,
        html: window.CGPT.cleanMessageHtml(item.html),
      }));

      // Самопроверка: понятная причина при сбое + ранний сигнал о смене вёрстки ChatGPT.
      const strategy = globalThis.CGPT_DOM.detectStrategy();
      const verdict = window.CGPT.collectionVerdict({
        rawCount: rawItems.length,
        cleanedCount: cleaned.length,
        strategy: strategy,
      });
      // Событие дрейфа вёрстки (зацепка для сторожа #22): сработал запасной селектор.
      if (strategy !== 'role' && globalThis.CGPT_EVENTS) {
        globalThis.CGPT_EVENTS.track('layout_drift', { strategy: strategy });
      }
      if (verdict.warn) {
        console.warn(verdict.warn);
      }
      if (!verdict.ok) {
        if (globalThis.CGPT_EVENTS) {
          globalThis.CGPT_EVENTS.track('export_failed', {
            reason: verdict.code === 'no-messages' ? 'no-messages' : 'empty',
          });
        }
        reportError(verdict.message);
        return;
      }

      // Встраиваем картинки как data-URL: на странице печати ссылки ChatGPT не грузятся
      // (нужна авторизация), а здесь, на chatgpt.com, куки есть. Делаем best-effort.
      try {
        await inlineAllImages(cleaned);
      } catch (imgErr) {
        console.error('CGPT: встраивание картинок дало сбой', imgErr);
      }

      if (globalThis.CGPT_EVENTS) {
        const images = cleaned.reduce((n, m) => n + ((m.html.match(/<img/g) || []).length), 0);
        globalThis.CGPT_EVENTS.track('export_succeeded', {
          messages: cleaned.length,
          images: images,
          durationMs: Date.now() - t0,
        });
      }

      // Канарейка: сигналим в аналитику, если тип контента со страницы пропал в выводе.
      contentCanary(cleaned);

      const payload = {
        // Заголовок вставляется в документ через textContent (print.js), экранировать не нужно.
        title: document.title || 'ChatGPT conversation',
        exportedAt: new Date().toISOString(),
        messages: cleaned,
      };

      const key = 'cgpt_export_' + Date.now();
      try {
        await chrome.storage.local.set({ [key]: payload });
      } catch (quotaErr) {
        console.error('CGPT: не удалось сохранить разговор во временное хранилище', quotaErr);
        if (globalThis.CGPT_EVENTS) { globalThis.CGPT_EVENTS.track('export_failed', { reason: 'quota' }); }
        reportError('The conversation is too large to save at once. Try a shorter chat.');
        return;
      }

      // Открываем окно печати через background (создание вкладки расширением): открытие
      // вкладки расширением не попадает под блокировщик всплывающих окон.
      await chrome.runtime.sendMessage({ type: 'CGPT_OPEN_PRINT', key }).catch(() => {});
    } catch (err) {
      console.error('CGPT: сбор разговора завершился ошибкой', err);
      if (globalThis.CGPT_EVENTS) { globalThis.CGPT_EVENTS.track('export_failed', { reason: 'error' }); }
      reportError('Could not read the conversation. Is this an open ChatGPT chat? Reload the page and try again.');
    }
  }

  // Команда на сбор приходит от background (тот получает её от попапа).
  chrome.runtime.onMessage.addListener((message) => {
    try {
      if (message && message.type === 'CGPT_EXPORT') {
        runExport();
      }
    } catch (err) {
      console.error('CGPT: обработка команды расширения дала сбой', err);
    }
  });
})();
