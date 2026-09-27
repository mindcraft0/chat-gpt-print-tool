/*
 * print.js - строит документ из собранного разговора и вызывает печать браузера.
 * Читает ключ из адреса, берёт данные из локального хранилища и сразу их удаляет
 * (приватность: разговор не должен оставаться в хранилище дольше необходимого).
 */

(function () {
  'use strict';

  const IMAGE_LOAD_TIMEOUT_MS = 4000;

  /**
   * Показывает понятную надпись вместо документа (пусто/ошибка), печать не вызывается.
   * @param {string} text - сообщение для пользователя
   */
  function showMessage(text) {
    try {
      const header = document.getElementById('cgpt-header');
      const content = document.getElementById('cgpt-content');
      if (header) {
        header.textContent = '';
      }
      if (content) {
        content.textContent = '';
        const box = document.createElement('div');
        box.className = 'cgpt-empty';
        box.textContent = text;
        content.appendChild(box);
      }
    } catch (err) {
      console.error('CGPT print: не удалось показать сообщение', err);
    }
  }

  /**
   * Строит шапку документа (заголовок, дата, наша подпись).
   * @param {{title:string, exportedAt:string}} data
   */
  function renderHeader(data) {
    const header = document.getElementById('cgpt-header');
    if (!header) {
      return;
    }

    const title = document.createElement('h1');
    title.textContent = data.title || 'ChatGPT conversation';

    const meta = document.createElement('div');
    meta.className = 'cgpt-meta';
    const dateText = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : '';
    meta.textContent = dateText ? 'Exported: ' + dateText : '';

    const brand = document.createElement('div');
    brand.className = 'cgpt-brand';
    brand.textContent = 'Saved from ChatGPT';

    header.appendChild(title);
    header.appendChild(meta);
    header.appendChild(brand);
  }

  /**
   * Строит блоки сообщений в контейнере содержимого документа.
   * Используем DocumentFragment, чтобы вставить все сообщения одной перестройкой.
   * @param {Array<{role:string, html:string}>} messages
   */
  function renderMessages(messages) {
    const content = document.getElementById('cgpt-content');
    if (!content) {
      return;
    }

    const fragment = document.createDocumentFragment();

    messages.forEach((msg) => {
      const wrap = document.createElement('div');
      wrap.className = 'cgpt-message';

      const roleLabel = document.createElement('div');
      const isUser = msg.role === 'user';
      roleLabel.className = 'cgpt-role ' + (isUser ? 'cgpt-role--user' : 'cgpt-role--assistant');
      roleLabel.textContent = isUser ? 'You' : 'ChatGPT';

      const body = document.createElement('div');
      body.className = 'cgpt-body';
      // html уже прошёл очистку в content.js (cleanMessageHtml) до сохранения в хранилище.
      body.innerHTML = msg.html || '';

      wrap.appendChild(roleLabel);
      wrap.appendChild(body);
      fragment.appendChild(wrap);
    });

    content.appendChild(fragment);
  }

  /**
   * Ждёт загрузки всех картинок документа с ограничением по времени на каждую,
   * чтобы недоступная картинка не подвесила печать навсегда.
   * @returns {Promise<void>}
   */
  function waitForImages() {
    try {
      const images = Array.from(document.querySelectorAll('img'));
      if (images.length === 0) {
        return Promise.resolve();
      }

      const waiters = images.map((img) => {
        if (img.complete) {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          const timer = setTimeout(resolve, IMAGE_LOAD_TIMEOUT_MS);
          img.addEventListener('load', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
          img.addEventListener('error', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      });

      return Promise.all(waiters);
    } catch (err) {
      console.error('CGPT print: ожидание картинок дало сбой', err);
      return Promise.resolve();
    }
  }

  /**
   * Помечает значки источников, чтобы они остались размером с букву.
   *
   * Жалоба пользователя 14.09.2026: «when the chat have links at the end of the paragraph,
   * the icons are huge in pdf». На живой странице ChatGPT размер значку задают классы его
   * вёрстки; в наш документ они не переезжают, и картинка рисуется в натуральную величину
   * (у index.hr это 128 пикселей - красный квадрат, разрывающий абзац).
   *
   * Признак значка выбран структурный, а не по размеру: картинка внутри ССЫЛКИ, У КОТОРОЙ
   * ЕСТЬ ТЕКСТ. Это ровно ссылка на источник («значок + Index»). Настоящая картинка в
   * подписанной ссылке в чатах не встречается, а судить по натуральному размеру нельзя -
   * он как раз большой.
   * @returns {number} сколько значков помечено
   */
  function tameLinkIcons() {
    try {
      let marked = 0;
      Array.from(document.querySelectorAll('.cgpt-body a img')).forEach((img) => {
        const link = typeof img.closest === 'function' ? img.closest('a') : null;
        if (!link) return;
        const label = (link.textContent || '').trim();
        if (label.length === 0) return;   // ссылка без текста - это может быть настоящая картинка
        img.classList.add('cgpt-icon');
        marked++;
      });
      return marked;
    } catch (err) {
      console.error('CGPT print: разметка значков источников дала сбой', err);
      return 0;
    }
  }

  /**
   * Убирает картинки, которые так и не загрузились.
   *
   * Зачем (#93, 12.09.2026): с этой версии картинки сверх потолка встраивания остаются в
   * документе обычными ссылками, а не удаляются. Почти всегда страница печати заберёт их
   * сама. Но если не заберёт - протухла подпись адреса, нет сети, - в PDF встанет БИТАЯ
   * ИКОНКА, и это хуже прежнего: раньше человек просто не видел картинки, а теперь увидел
   * бы сломанную. Поэтому перед печатью выметаем всё, что не отрисовалось: худший случай
   * становится ровно таким, каким был раньше, и живой проверки не требует.
   * @returns {number} сколько картинок убрано
   */
  function dropBrokenImages() {
    try {
      let removed = 0;
      Array.from(document.querySelectorAll('img')).forEach((img) => {
        if (img.naturalWidth === 0) {
          img.remove();
          removed++;
          return;
        }
        // Страховка к tameLinkIcons: картинка в 64 пикселя и меньше содержанием не бывает,
        // это значок. Ловит случаи, когда ссылка вокруг значка оказалась без текста.
        if (img.naturalWidth <= 64 && img.naturalHeight <= 64) {
          img.classList.add('cgpt-icon');
        }
      });
      if (removed > 0) {
        console.warn('CGPT print: убрано не загрузившихся картинок:', removed);
      }
      return removed;
    } catch (err) {
      console.error('CGPT print: чистка не загрузившихся картинок дала сбой', err);
      return 0;
    }
  }

  /**
   * Одна строка в консоль о том, что реально попало в документ. Нужна, чтобы разбирать
   * жалобы вида «картинки нет в PDF» БЕЗ вставки диагностических скриптов руками (#86):
   * достаточно открыть консоль вкладки печати и прочитать строку.
   * Приватность не страдает: только числа и схема адреса, без содержимого разговора.
   * @param {{messages: Array<{html?: string}>}} data
   */
  function reportBuild(data) {
    try {
      const msgs = (data && data.messages) || [];
      const imgs = Array.from(document.querySelectorAll('.cgpt-body img'));
      const broken = imgs.filter((im) => !im.naturalWidth).length;
      const external = imgs.filter((im) => !String(im.getAttribute('src') || '').startsWith('data:')).length;
      // Вес встроенной картинки важен: на data-URL в несколько мегабайт предпросмотр печати
      // Chrome спотыкается и теряет картинку, хотя на экране она видна (#86).
      const heaviest = imgs.reduce((max, im) => Math.max(max, String(im.getAttribute('src') || '').length), 0);
      console.info(
        'Vellum print: сообщений ' + msgs.length
        + ', картинок в документе ' + imgs.length
        + ' (встроенных ' + (imgs.length - external) + ', внешних ссылок ' + external + ')'
        + ', не отрисовалось ' + broken
        + ', самая тяжёлая ' + Math.round(heaviest / 1024) + ' КБ',
      );
      if (imgs.length === 0) {
        console.warn('Vellum print: картинок в документе НЕТ. Если на странице чата они были - потеря произошла до сохранения, на этапе сбора.');
      }
      if (broken > 0) {
        console.warn('Vellum print: часть картинок не отрисовалась. Внешняя ссылка на странице печати не грузится - нет кук ChatGPT.');
      }
    } catch (err) {
      /* диагностика не должна мешать печати */
    }
  }

  /**
   * Достаёт ключ выгрузки из query-параметра адреса страницы.
   * @returns {string|null}
   */
  function readKeyFromLocation() {
    const params = new URLSearchParams(window.location.search);
    return params.get('k');
  }


  /**
   * Подгоняет выключные формулы под ширину печатного листа.
   *
   * Ключевое отличие от прошлой версии: сравниваем СОБСТВЕННУЮ ширину формулы
   * (она не зависит от контейнера) с фиксированной печатной шириной, а не с
   * шириной контейнера на экране - на экране и на листе она разная, из-за чего
   * прошлый расчёт промахивался. Плюс страховка: если TeX-исходника нет, берём
   * текст прямо из формулы, поэтому блок никогда не остаётся пустым.
   *
   * - формула чуть шире листа: мягкий масштаб (остаётся читаемой);
   * - формула сильно шире листа: переносим её как обычный текст (TeX или, если его
   *   нет, линейная запись из самой формулы) - ничего не обрезается;
   */
  const PRINT_SAFE_WIDTH = 640; // консервативная ширина области печати (px) для A4/Letter с полями

  function textFallback(block, math) {
    const tex = block.getAttribute('data-tex');
    const linear = math ? (math.textContent || '').trim() : '';
    return (tex && tex.trim()) ? tex.trim() : linear;
  }

  function renderTexWrap(block, text) {
    block.textContent = '';
    block.style.height = '';
    block.style.textAlign = 'left';
    const pre = document.createElement('div');
    pre.className = 'cgpt-tex-wrap';
    pre.textContent = text || '[formula]';
    block.appendChild(pre);
  }

  function applyScale(block, math, k) {
    math.style.transformOrigin = 'left top';
    math.style.transform = 'scale(' + k + ')';
    block.style.height = Math.ceil(math.getBoundingClientRect().height) + 'px';
    block.style.textAlign = 'left';
  }

  function fitWideMath() {
    try {
      document.querySelectorAll('.cgpt-math-display').forEach((block) => {
        const math = block.querySelector('math');
        if (!math) {
          // MathML не построился (запасной вид) - если содержимое шире листа, перенесём текстом
          if (block.scrollWidth > PRINT_SAFE_WIDTH) {
            renderTexWrap(block, textFallback(block, null));
          }
          return;
        }
        math.style.transform = '';
        math.style.display = 'inline-block';
        const own = math.getBoundingClientRect().width; // собственная ширина формулы
        if (own <= PRINT_SAFE_WIDTH) {
          return; // влезает на лист - не трогаем
        }
        const k = PRINT_SAFE_WIDTH / own;
        if (k >= 0.7) {
          applyScale(block, math, k * 0.98); // чуть шире - мягко ужимаем, читаемо
        } else {
          renderTexWrap(block, textFallback(block, math)); // сильно шире - переносим текстом
        }
      });
    } catch (err) {
      console.error('CGPT print: подгонка широкой формулы дала сбой', err);
    }
  }

  /**
   * Принудительно загружает вшитый CJK-шрифт и дожидается его ДО печати.
   * Почему недостаточно document.fonts.ready: он ждёт только те шрифты, что уже
   * начали грузиться. Вшитый CJK (несколько МБ) подгружается лениво, и печать
   * успевала стартовать раньше - в PDF попадал тофу, хотя на экране шрифт потом
   * догружался и всё выглядело верно. document.fonts.load() форсирует загрузку.
   * @returns {Promise<void>}
   */
  async function ensureFontsLoaded() {
    try {
      if (!document.fonts || !document.fonts.load) {
        return;
      }
      const probes = [
        ["400 16px 'Noto Sans CJK bundled'", '日本語中文한국어'],
      ];
      await Promise.all(probes.map((p) => document.fonts.load(p[0], p[1]).catch(() => {})));
      if (document.fonts.ready) {
        await document.fonts.ready.catch(() => {});
      }
    } catch (err) {
      console.error('CGPT print: не удалось дождаться загрузки шрифтов', err);
    }
  }

  async function main() {
    try {
      const key = readKeyFromLocation();
      if (!key) {
        showMessage('Conversation key not found. Start saving again from the ChatGPT page.');
        return;
      }

      const stored = await chrome.storage.local.get(key);
      const data = stored ? stored[key] : null;

      // Сразу удаляем данные из хранилища вне зависимости от исхода - приватность важнее повтора.
      chrome.storage.local.remove(key).catch((err) => {
        console.error('CGPT print: не удалось удалить временные данные', err);
      });

      if (!data || !Array.isArray(data.messages) || data.messages.length === 0) {
        showMessage('The conversation is empty or not found. Go back to the ChatGPT page and try again.');
        return;
      }

      renderHeader(data);
      renderMessages(data.messages);
      // До ожидания загрузки: значку не нужен натуральный размер, он и так станет с букву.
      tameLinkIcons();

      await waitForImages();
      // Порядок важен: сначала ждём загрузку, потом выметаем то, что не загрузилось, и
      // только потом пишем диагностическую строку - иначе она соврёт о числе картинок.
      dropBrokenImages();
      reportBuild(data);
      // Гарантируем, что вшитый CJK-шрифт реально загружен ДО печати (иначе тофу в PDF)
      // и до замера ширины формул (иначе неверный масштаб).
      await ensureFontsLoaded();
      fitWideMath();
      if (typeof globalThis !== 'undefined' && globalThis.CGPT_EVENTS) {
        globalThis.CGPT_EVENTS.track('print_opened');
      }
      window.print();
    } catch (err) {
      console.error('CGPT print: сбой построения документа', err);
      showMessage('Could not build the document for printing. Try saving the conversation again.');
    }
  }

  main();
})();
