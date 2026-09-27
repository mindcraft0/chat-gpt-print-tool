/*
 * popup.js - логика окна расширения. По кнопке просит background запустить сбор на
 * активной вкладке, показывает ход сбора и ошибки. Когда открывается вкладка печати,
 * окно расширения закрывается само (обычное поведение попапа).
 */

(function () {
  'use strict';

  const btn = document.getElementById('save');
  const statusEl = document.getElementById('status');
  const labelEl = btn ? btn.querySelector('.btn-label') : null;
  let busy = false;
  if (window.CGPT_EVENTS) { window.CGPT_EVENTS.track('popup_opened'); }

  /**
   * Обновляет строку состояния под кнопкой.
   * @param {string} text
   * @param {boolean} isError
   */
  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (isError ? ' status--error' : '');
  }

  /**
   * Переводит кнопку в состояние «идёт сбор»: спиннер + «Saving…», кнопка остаётся яркой,
   * повторный клик заблокирован (флаг busy + класс is-busy с pointer-events:none).
   * @param {boolean} on
   * @param {string} [label] - текст на кнопке (по умолчанию Saving… / Save to PDF)
   */
  function setBusy(on, label) {
    busy = on;
    if (btn) { btn.classList.toggle('is-busy', on); }
    if (labelEl) { labelEl.textContent = label || (on ? 'Saving…' : 'Save to PDF'); }
  }

  btn.addEventListener('click', () => {
    if (busy) { return; }
    try {
      setBusy(true, 'Saving…');
      setStatus('Collecting the conversation...', false);
      if (window.CGPT_EVENTS) { window.CGPT_EVENTS.track('export_started'); }
      // Запуск делаем через background: он подсадит сбор-часть в старую вкладку при
      // необходимости и пошлёт ей команду. Ход и ошибки прилетят сюда сообщениями.
      chrome.runtime.sendMessage({ type: 'CGPT_START' }).catch((err) => {
        console.error('CGPT popup: не удалось отправить команду запуска', err);
      });
    } catch (err) {
      console.error('CGPT popup: сбой при запуске', err);
      setStatus('Could not start saving.', true);
      setBusy(false);
    }
  });

  // Сообщения от сбор-части: ход сбора и ошибки. Успех виден сам: открывается окно
  // печати, а это окно расширения закрывается.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) {
      return;
    }
    if (message.type === 'CGPT_PROGRESS') {
      setStatus('Collecting: ' + message.count + ' messages', false);
    } else if (message.type === 'CGPT_ERROR') {
      setStatus(message.message || 'Could not save the conversation.', true);
      setBusy(false);
    }
  });

  // --- Машина отзывов (#25): разовый вежливый запрос после нескольких успехов. ---

  /** Сохраняет патч состояния отзыва и, по желанию, шлёт событие. */
  function updateReview(patch, eventName) {
    try {
      if (eventName && window.CGPT_EVENTS) {
        window.CGPT_EVENTS.track(eventName);
      }
      chrome.storage.local.get([window.CGPT_REVIEW.REVIEW_STATE_KEY]).then((data) => {
        const state = (data && data[window.CGPT_REVIEW.REVIEW_STATE_KEY]) || {};
        const next = Object.assign({}, state, patch);
        chrome.storage.local.set({ [window.CGPT_REVIEW.REVIEW_STATE_KEY]: next }).catch(() => {});
      }).catch(() => {});
    } catch (err) {
      console.error('CGPT popup: обновление состояния отзыва дало сбой', err);
    }
  }

  /** Показывает запрос отзыва, если условия выполнены (порог успехов, не спрашивали). */
  function maybeShowReview() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !window.CGPT_REVIEW) {
        return;
      }
      chrome.storage.local.get(['cgpt_events', window.CGPT_REVIEW.REVIEW_STATE_KEY]).then((data) => {
        const counters = (data && data.cgpt_events && data.cgpt_events.counters) || {};
        const successCount = counters.export_succeeded || 0;
        const state = (data && data[window.CGPT_REVIEW.REVIEW_STATE_KEY]) || {};
        if (!window.CGPT_REVIEW.shouldAsk(state, successCount)) {
          return;
        }
        const box = document.getElementById('review');
        if (!box) {
          return;
        }
        box.hidden = false;
        // Помечаем asked сразу при показе, чтобы не спрашивать повторно даже если проигнорируют.
        updateReview({ asked: true }, 'review_prompt_shown');
      }).catch(() => {});
    } catch (err) {
      console.error('CGPT popup: показ запроса отзыва дал сбой', err);
    }
  }

  const rateBtn = document.getElementById('review-rate');
  const laterBtn = document.getElementById('review-later');
  if (rateBtn) {
    rateBtn.addEventListener('click', () => {
      updateReview({ done: true }, 'review_prompt_accepted');
      try { chrome.tabs.create({ url: window.CGPT_REVIEW.REVIEW_URL }); } catch (e) { /* ничего */ }
      const box = document.getElementById('review');
      if (box) { box.hidden = true; }
    });
  }
  if (laterBtn) {
    laterBtn.addEventListener('click', () => {
      updateReview({ dismissed: true }, 'review_prompt_dismissed');
      const box = document.getElementById('review');
      if (box) { box.hidden = true; }
    });
  }

  maybeShowReview();
})();
