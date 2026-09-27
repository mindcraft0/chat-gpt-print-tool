/*
 * config.js - конфиг расширения. ЗАПОЛНИТЬ при заведении потока GA4 и страницы-опроса.
 * Важно: у расширения нет рантайм-env, поэтому эти значения окажутся в бандле. Для
 * GA4 Measurement Protocol api_secret на клиенте - известное ограничение (полусекрет),
 * не пароль от аккаунта. Реальный вред от утечки ограничен присылкой мусорных событий.
 */
const CGPT_CONFIG = {
  // GA4: Admin -> Data Streams -> ваш веб-поток -> "Measurement ID" (вида G-XXXXXXX).
  GA4_MEASUREMENT_ID: 'G-R57B3LV4YH',
  // GA4: тот же Data Stream -> Measurement Protocol API secrets -> Create.
  // НЕ вписывать секрет сюда и НЕ коммитить его. В репозитории всегда заглушка;
  // настоящий ключ подставляется при сборке публикуемого расширения:
  //   GA4_API_SECRET=xxxx node scripts/build.js  -> dist/  (#27)
  GA4_API_SECRET: 'jQTtZbHcQlG8JfB_dUI0vw',
  // Страница-опрос «почему удалили», открывается при удалении расширения.
  UNINSTALL_SURVEY_URL: 'https://corpvellum.com/uninstall',
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CGPT_CONFIG;
}
if (typeof globalThis !== 'undefined') {
  globalThis.CGPT_CONFIG = CGPT_CONFIG;
}
