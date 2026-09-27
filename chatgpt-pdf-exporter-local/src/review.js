/*
 * review.js - «машина отзывов» (#25): вежливый РАЗОВЫЙ запрос отзыва после того, как
 * пользователь получил пользу (несколько успешных экспортов). Правила магазина:
 * просить можно; покупать, накручивать, подкупать - нельзя. Спрашиваем один раз,
 * ровным темпом, и уважаем отказ. Чистое решение shouldAsk() тестируется отдельно.
 * Двойной режим: модуль Node (тесты) и скрипт в браузере (globalThis.CGPT_REVIEW).
 */

// После скольких успешных экспортов уместно попросить отзыв (пользователь уже в плюсе).
const REVIEW_THRESHOLD = 3;
const REVIEW_STATE_KEY = 'cgpt_review';
// Страница отзывов нашего листинга. ID расширения выдан магазином при загрузке архива
// 2026-07-13 (до публикации): jehoafilhpddalhmhgpcflmfcknkmhol. ID постоянный и не меняется
// при обновлениях, но менялся бы при заливке НОВОГО объекта - тогда правим здесь.
const REVIEW_URL = 'https://chromewebstore.google.com/detail/jehoafilhpddalhmhgpcflmfcknkmhol/reviews';

/**
 * Спрашивать ли отзыв сейчас? Не спрашиваем, если уже спрашивали, отклонили или
 * пользователь уже оценил; спрашиваем только после порога успешных экспортов.
 * @param {{asked?:boolean, dismissed?:boolean, done?:boolean}} state
 * @param {number} successCount - сколько было успешных экспортов
 * @returns {boolean}
 */
function shouldAsk(state, successCount) {
  const s = state || {};
  if (s.done || s.dismissed || s.asked) {
    return false;
  }
  const n = typeof successCount === 'number' ? successCount : 0;
  return n >= REVIEW_THRESHOLD;
}

const CGPT_REVIEW = { REVIEW_THRESHOLD, REVIEW_STATE_KEY, REVIEW_URL, shouldAsk };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CGPT_REVIEW;
}
if (typeof globalThis !== 'undefined') {
  globalThis.CGPT_REVIEW = CGPT_REVIEW;
}
