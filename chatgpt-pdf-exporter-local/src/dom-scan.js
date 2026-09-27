/*
 * dom-scan.js - поиск сообщений разговора на странице ChatGPT и чтение их содержимого.
 * Вынесено из content.js отдельным файлом, чтобы каждый файл отвечал за одно и не
 * превышал лимит строк. Вешает функции на globalThis.CGPT_DOM.
 */

(function () {
  'use strict';

  const MARKDOWN_ROOT_SELECTOR = '[class^="MarkdownRoot-"], [class*=" MarkdownRoot-"]';

  /**
   * Ищет прокручиваемый контейнер разговора: берём ближайшего прокручиваемого
   * предка первого найденного сообщения, иначе - окно целиком.
   * @param {Element|null} firstMessageEl
   * @returns {Element|Window}
   */
  function findScrollContainer(firstMessageEl) {
    let node = firstMessageEl ? firstMessageEl.parentElement : null;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const canScroll = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      if (canScroll) {
        return node;
      }
      node = node.parentElement;
    }
    return window;
  }

  /**
   * Находит все узлы сообщений на странице цепочкой запасных селекторов,
   * потому что оформление ChatGPT меняется, а устойчивые метки - нет.
   * @returns {Element[]}
   */
  function findMessageNodes() {
    const byRole = Array.from(document.querySelectorAll('[data-message-author-role]'));
    if (byRole.length === 0) {
      const byTurn = document.querySelectorAll('[data-testid^="conversation-turn"]');
      if (byTurn.length > 0) {
        return Array.from(byTurn);
      }
      const main = document.querySelector('main');
      const articles = main ? Array.from(main.querySelectorAll('article')) : [];
      if (articles.length > 0) {
        return articles;
      }
      return Array.from(document.querySelectorAll(MARKDOWN_ROOT_SELECTOR));
    }

    // Добираем «ходы» разговора со сгенерированной картинкой, у которых НЕТ узла роли
    // (генерация ChatGPT рендерится вне [data-message-author-role] - см. conversation-turn-2).
    const nodes = byRole.slice();
    document.querySelectorAll('[data-testid^="conversation-turn"]').forEach((turn) => {
      if (turn.querySelector('[data-message-author-role]')) {
        return; // такой ход уже покрыт узлом роли
      }
      const hasContentImg = Array.from(turn.querySelectorAll('img'))
        .some((img) => isContentImg(img.getAttribute('src') || img.currentSrc || ''));
      if (hasContentImg) {
        nodes.push(turn);
      }
    });

    // Порядок документа: чтобы картинка-генерация встала на своё место, а не в конец.
    nodes.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return nodes;
  }

  /**
   * Определяет роль автора сообщения (user/assistant).
   * @param {Element} node
   * @returns {string}
   */
  function roleOfNode(node) {
    const direct = node.getAttribute('data-message-author-role');
    if (direct) {
      return direct;
    }
    const nested = node.querySelector('[data-message-author-role]');
    if (nested) {
      return nested.getAttribute('data-message-author-role') || 'assistant';
    }
    if (typeof node.closest === 'function' && node.closest('[class*="bg-user-message"]')) {
      return 'user';
    }
    return 'assistant';
  }

  /**
   * Устойчивый идентификатор сообщения: сначала настоящий id, иначе отпечаток
   * по содержимому (роль + длина + первые символы текста), чтобы не путать
   * разные сообщения при отсутствии data-message-id.
   * @param {Element} node
   * @param {string} role
   * @returns {string}
   */
  function idOfNode(node, role) {
    const direct = node.getAttribute('data-message-id');
    if (direct) {
      return direct;
    }
    const nested = node.querySelector('[data-message-id]');
    if (nested) {
      return nested.getAttribute('data-message-id');
    }
    // Ход-картинка (генерация ChatGPT) без data-message-id: текста нет, поэтому отпечаток
    // держится на позиции узла. А позиция ПЛЫВЁТ во время прокрутки - картинка догружается,
    // раскладка сдвигается, - и один и тот же ход получает два разных id: в документ он
    // попадает ДВАЖДЫ (баг 2026-07-11: картинка в конце PDF выводилась два раза).
    // Ключуем такие ходы по самой картинке: это устойчиво к любой раскладке.
    const imgKeys = Array.from(node.querySelectorAll('img'))
      .map((img) => img.getAttribute('src') || img.currentSrc || '')
      .filter(isContentImg)
      .map(imgFileKey)
      .sort();
    if (imgKeys.length > 0 && (node.textContent || '').trim().length === 0) {
      // Номер хода спереди по той же причине, что и ниже: две РАЗНЫЕ генерации с одинаковым
      // файлом картинки (повтор запроса) иначе схлопнулись бы в один ход.
      const imgTurn = turnIndexOfNode(node);
      return (Number.isFinite(imgTurn) ? 't' + imgTurn + ':' : '') + 'img:' + imgKeys.join(',');
    }

    // Без data-message-id одного текста мало: два одинаковых коротких сообщения
    // ("Да", "Ок") дали бы одинаковый отпечаток и схлопнулись бы в dedupeOrdered,
    // потеряв сообщение. Добавляем СТАБИЛЬНУЮ позицию сообщения в документе
    // (абсолютный top, округлённый): у одного и того же узла между проходами
    // прокрутки она одна и та же, а у разных сообщений - разная.
    const text = (node.textContent || '').trim();
    // Стабильная позиция в РАСКЛАДКЕ (offsetTop), а не во вьюпорте: она не меняется
    // при прокрутке, в том числе когда разговор прокручивается ВНУТРИ контейнера,
    // а не окна - это как раз случай ChatGPT. getBoundingClientRect().top тут "плыл"
    // бы при прокрутке и мог давать одному сообщению разные id (дубли).
    let pos = 0;
    try {
      let cur = node, acc = 0, guard = 0;
      while (cur && guard++ < 50) { acc += cur.offsetTop || 0; cur = cur.offsetParent; }
      pos = Math.round(acc / 8);
    } catch (err) {
      pos = 0;
    }
    // Номер хода в ключ (#93, 10.09.2026). Отпечаток по «роль + позиция + текст» может
    // совпасть у ДВУХ РАЗНЫХ ходов: два коротких одинаковых сообщения на близких позициях
    // (позиция округляется до 8 пикселей) дают один ключ. Тогда второй ход не добавляется
    // в сборку вовсе - он «уже есть», - его номер выпадает из ряда, и канарейка честно
    // сообщает о потере целого сообщения. Номер хода стабилен между проходами прокрутки,
    // поэтому дедуп одного и того же узла он не ломает, а разные ходы разводит намертво.
    const turnNo = turnIndexOfNode(node);
    const turnPart = Number.isFinite(turnNo) ? 't' + turnNo + ':' : '';
    return turnPart + role + ':' + pos + ':' + text.length + ':' + text.slice(0, 80);
  }

  /**
   * Номера ходов, реально размеченные на странице ПРЯМО СЕЙЧАС. Нужен, чтобы отличить
   * «ход есть, но мы его не собрали» от «хода с таким номером на странице нет вовсе»
   * (см. classifyMissingTurns в lib.js).
   * @returns {number[]}
   */
  function presentTurnNumbers() {
    try {
      const out = [];
      document.querySelectorAll('[data-testid^="conversation-turn"]').forEach((el) => {
        const m = /conversation-turn-(\d+)/.exec(el.getAttribute('data-testid') || '');
        if (m) out.push(Number(m[1]));
      });
      return out;
    } catch (err) {
      return [];
    }
  }

  /**
   * Настоящий номер хода в разговоре: ChatGPT размечает каждый ход
   * data-testid="conversation-turn-N". Это ЕДИНСТВЕННЫЙ надёжный порядок.
   * Порядок «в каком месте прокрутки сообщение попалось» им не является: из-за
   * виртуализации часть ходов не смонтирована, попадается позже и уезжает в конец
   * документа (баг 2026-07-11: математика и код приклеились после последнего ответа,
   * а вопрос про прайсинг осиротел в самом конце).
   * @param {Element} node
   * @returns {number|null} номер хода или null, если разметки нет
   */
  function turnIndexOfNode(node) {
    try {
      const turn = typeof node.closest === 'function'
        ? node.closest('[data-testid^="conversation-turn"]')
        : null;
      const el = turn || node;
      const id = el.getAttribute ? el.getAttribute('data-testid') : null;
      const m = /conversation-turn-(\d+)/.exec(id || '');
      return m ? Number(m[1]) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Достаёт HTML содержимого сообщения (сам текст ответа/вопроса, без служебной обвязки узла).
   * Сначала пробуем узел разметки ответа, потом прямой блок под ролью, и лишь затем
   * весь узел целиком, чтобы по возможности не тащить в документ обвязку интерфейса.
   * @param {Element} node
   * @returns {string}
   */
  // Ссылки-картинки контента ChatGPT (сгенерированные/приложенные), а не аватарки/иконки UI.
  function isContentImg(src) {
    return /backend-api\/|oaiusercontent|images\.openai\.com|\/estuary\//i.test(src || '');
  }

  // Ключ картинки: ChatGPT рисует ОДНУ картинку несколькими копиями (превью + лайтбокс),
  // и адреса этих копий РАЗНЫЕ. Считать их одной по строке src нельзя.
  // 1) Если в адресе есть file-id (file_xxx) - ключ по нему.
  // 2) У сгенерированных картинок (images.openai.com) file-id нет: раньше ключом
  //    становился весь URL, копии получали разные ключи и картинка приклеивалась
  //    ВТОРОЙ раз (баг 2026-07-11: дубль картинки в конце PDF). Запасной ключ -
  //    последний сегмент пути без query: у копий одной картинки он совпадает.
  function imgFileKey(src) {
    const s = String(src || '');
    const m = s.match(/file[_-]([a-z0-9]+)/i);
    if (m) return 'file_' + m[1].toLowerCase(); // file_x и file-x - один и тот же id
    const noQuery = s.split('?')[0].split('#')[0];
    const seg = noQuery.substring(noQuery.lastIndexOf('/') + 1);
    return (seg || noQuery).toLowerCase();
  }

  // Регистрирует картинки, УЖЕ присутствующие в html, чтобы не приклеить их повторно.
  // Сравнивать сами строки src бесполезно - у копий одной картинки адреса разные,
  // поэтому сводим их к общему ключу.
  function seedSeenFromHtml(html, seen) {
    const re = /<img[^>]+src\s*=\s*"([^"]+)"/gi;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) {
      seen.add(imgFileKey(m[1]));
    }
    return seen;
  }

  // Уникальные контентные картинки узла, в порядке разметки. Дедуп по ключу файла.
  function contentImagesOf(node, seen) {
    const out = [];
    node.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || img.currentSrc || '';
      if (!isContentImg(src)) return;
      const key = imgFileKey(src);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        el: img,
        tag: '<img src="' + src.replace(/"/g, '&quot;') + '" alt="'
          + (img.getAttribute('alt') || '').replace(/"/g, '&quot;') + '">',
      });
    });
    return out;
  }

  // Порядковый номер узла в документе относительно якоря. 2 - это
  // Node.DOCUMENT_POSITION_PRECEDING; числом, чтобы функция работала и в тестах без DOM.
  const DOCUMENT_POSITION_PRECEDING = 2;

  /**
   * Ставит контентные картинки узла в html ПО ФАКТИЧЕСКОМУ ПОРЯДКУ разметки: те, что
   * стоят в документе выше якоря (узла сообщения), идут перед текстом, остальные после.
   *
   * ЗАЧЕМ (#86): картинка лежит в ветке-соседе, и раньше добор просто дописывал её в
   * КОНЕЦ сообщения. Если человек попросил «сначала картинку, потом код и таблицу»,
   * в PDF картинка оказывалась последней и уезжала на второй лист. Порядок ответа - это
   * содержание, а не оформление, терять его нельзя.
   * @param {Element} scope - область поиска картинок (обычно контейнер хода)
   * @param {Element} anchor - узел сообщения, относительно которого считаем порядок
   * @param {string} html - html тела сообщения
   * @param {Set<string>} seen - уже использованные ключи картинок
   * @returns {string}
   */
  function placeContentImages(scope, anchor, html, seen) {
    const out = html;
    seedSeenFromHtml(out, seen);
    let before = '', after = '';
    for (const it of contentImagesOf(scope, seen)) {
      const canCompare = anchor && typeof anchor.compareDocumentPosition === 'function';
      const precedes = canCompare
        && (anchor.compareDocumentPosition(it.el) & DOCUMENT_POSITION_PRECEDING);
      if (precedes) { before += it.tag; } else { after += it.tag; }
    }
    return before + out + after;
  }

  // Собирает уникальные контентные картинки узла в теги <img> и дописывает их В КОНЕЦ.
  // Для хода без тела (сообщение-картинка), где ставить относительно нечего.
  function appendContentImages(node, html, seen) {
    return placeContentImages(node, null, html, seen);
  }

  function isTransparentColor(c) {
    return !c || c === 'transparent' || /rgba?\([^)]*,\s*0\s*\)$/.test(c);
  }
  function isLightColor(c) {
    const m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c || '');
    if (!m) return false;
    return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) > 140;
  }

  // Сохраняет подсветку кода. ChatGPT красит токены сгенерированными на лету классами
  // CodeMirror (ͼu, ͼ13…) через отдельную таблицу стилей, которой у страницы печати нет.
  // Снимаем ФАКТИЧЕСКИЙ цвет каждого токена внутри <pre> И фон/цвет самого блока, чтобы
  // контраст совпадал с темой ChatGPT (светлая тема — тёмные токены на светлом фоне,
  // тёмная — светлые на тёмном). Всё вшиваем inline; блок помечаем классом cgpt-code.
  function codeColoredInnerHTML(root) {
    try {
      const clone = root.cloneNode(true);
      const livePres = root.querySelectorAll('pre');
      const clonePres = clone.querySelectorAll('pre');
      for (let i = 0; i < livePres.length && i < clonePres.length; i++) {
        const livePre = livePres[i], clonePre = clonePres[i];
        const live = livePre.querySelectorAll('*');
        const copy = clonePre.querySelectorAll('*');
        for (let j = 0; j < live.length && j < copy.length; j++) {
          const col = getComputedStyle(live[j]).color;
          if (col) copy[j].style.color = col;
        }
        // Фон блока: у самого <pre> он часто прозрачный — идём вверх до непрозрачного.
        const preCS = getComputedStyle(livePre);
        const textColor = preCS.color;
        let bg = preCS.backgroundColor, el = livePre, guard = 0;
        while (isTransparentColor(bg) && el.parentElement && guard++ < 6) {
          el = el.parentElement;
          bg = getComputedStyle(el).backgroundColor;
        }
        if (isTransparentColor(bg)) bg = isLightColor(textColor) ? '#0E1116' : '#f5f5f5';
        clonePre.style.backgroundColor = bg;
        clonePre.style.color = textColor;
        clonePre.classList.add('cgpt-code');
      }
      return clone.innerHTML;
    } catch (err) {
      console.error('CGPT: перенос цветов кода дал сбой', err);
      return root.innerHTML || '';
    }
  }

  /**
   * Область, в которой ищем картинки хода.
   *
   * ЗАМЕР 2026-09-07 (#86): ChatGPT рисует сгенерированную картинку в ВЕТКЕ-СОСЕДЕ
   * узла сообщения. Текст лежит в [data-message-author-role], картинка в
   * div#image-<uuid> рядом с ним, и обе ветки висят на общем контейнере хода
   * <section data-testid="conversation-turn-N">. Добор картинок от САМОГО узла
   * сообщения находил ноль картинок, и они молча пропадали из PDF.
   *
   * Поднимаемся до контейнера хода, но ТОЛЬКО если в нём ровно один узел сообщения:
   * иначе одна картинка приклеилась бы ко всем сообщениям хода (дубли в документе).
   * @param {Element} node
   * @returns {Element} область поиска картинок
   */
  function imageScopeOfNode(node) {
    try {
      if (!node || typeof node.closest !== 'function') {
        return node;
      }
      const turn = node.closest('[data-testid^="conversation-turn"]')
        || node.closest('[data-turn-id-container]')
        || node.closest('article');
      if (!turn || turn === node) {
        return node;
      }
      // Больше одного сообщения в ходе - остаёмся на узле, чтобы не задвоить картинку.
      if (turn.querySelectorAll('[data-message-author-role]').length > 1) {
        return node;
      }
      return turn;
    } catch (err) {
      return node;
    }
  }

  function htmlOfNode(node) {
    const isMarkdownRoot = typeof node.matches === 'function' && node.matches(MARKDOWN_ROOT_SELECTOR);
    const contentNode = isMarkdownRoot
      ? node
      : node.querySelector('.markdown, [data-message-author-role] > div');
    const seen = new Set();
    const imgScope = imageScopeOfNode(node);
    if (contentNode) {
      // Обычное сообщение: текст из .markdown + добор картинок вне него (дедуп по file-id).
      let html = codeColoredInnerHTML(contentNode);
      try { html = placeContentImages(imgScope, node, html, seen); }
      catch (err) { console.error('CGPT: добор картинок сообщения дал сбой', err); }
      return html;
    }
    // Ход без .markdown (например, сгенерированная картинка): берём ТОЛЬКО уникальные
    // картинки, без UI-обвязки и дублей-превью. Если картинок нет - весь узел как есть.
    try {
      const imgsOnly = appendContentImages(imgScope, '', seen);
      if (imgsOnly) return imgsOnly;
    } catch (err) {
      console.error('CGPT: сбор картинок хода дал сбой', err);
    }
    return node.innerHTML || '';
  }

  /**
   * Определяет, каким селектором находятся сообщения (для самопроверки/дрейфа вёрстки).
   * Тот же порядок приоритета, что и в findMessageNodes.
  * @returns {'role'|'turn'|'article'|'markdown'|'none'}
   */
  function detectStrategy() {
    if (document.querySelectorAll('[data-message-author-role]').length > 0) {
      return 'role';
    }
    if (document.querySelectorAll('[data-testid^="conversation-turn"]').length > 0) {
      return 'turn';
    }
    const main = document.querySelector('main');
    if (main && main.querySelectorAll('article').length > 0) {
      return 'article';
    }
    if (document.querySelectorAll(MARKDOWN_ROOT_SELECTOR).length > 0) {
      return 'markdown';
    }
    return 'none';
  }

  globalThis.CGPT_DOM = {
    findScrollContainer,
    findMessageNodes,
    detectStrategy,
    roleOfNode,
    idOfNode,
    htmlOfNode,
    turnIndexOfNode,
    presentTurnNumbers,
    // Ниже - чистые функции: вынесены наружу ради модульных тестов в Node.
    isContentImg,
    imgFileKey,
    seedSeenFromHtml,
    appendContentImages,
    placeContentImages,
    imageScopeOfNode,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.CGPT_DOM;
  }
})();
