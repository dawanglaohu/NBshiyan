// Shared OG subtitle (tagline) for render-og*.mjs.
// "Factory direct" / «Напрямую с фабрики» removed: we are a supplier, not our own factory (see mfr-claims audit).
export const EN_TAGLINE = 'Custom packaging, sample to bulk';
// TODO(ru-tagline): RU equivalent of "sample to bulk" is pending language-bot wording — do NOT invent it.
// Until then RU images show only the existing approved phrase below (factory claim removed).
export const RU_TAGLINE_TODO = null;
export const tag = { en: EN_TAGLINE, ru: RU_TAGLINE_TODO ?? 'Упаковка и печать на заказ' };
