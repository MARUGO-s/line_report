/**
 * Journal Reportブラウザ側の個人情報最小化。
 * 同じ処理をEdge Functionでも再実行し、外部AIへ本名・連絡先・アレルギー詳細を送らない。
 */
(function (global) {
  'use strict';

  function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function aliasFor(index) {
    var n = Math.max(0, Math.trunc(Number(index) || 0));
    var suffix = '';
    do {
      suffix = String.fromCharCode(65 + (n % 26)) + suffix;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return '予約客' + suffix;
  }

  function normalizeName(value) {
    var name = String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .replace(/(?:様|さん)$/u, '')
      .trim();
    if (!name || name.length > 80) return '';
    if (/^(?:氏名不明|予約客[A-Z]+|不明|null|undefined)$/i.test(name)) return '';
    return name;
  }

  function addName(names, value) {
    var name = normalizeName(value);
    if (name && names.indexOf(name) < 0) names.push(name);
  }

  function collectText(text, names) {
    var source = String(text || '');
    var detailRe = /^\s*-\s*\d{4}-\d{2}-\d{2}[^\n]*?\/\s*([^/\n]+?)\s*\//gmu;
    var match;
    while ((match = detailRe.exec(source))) addName(names, match[1]);
    var labelRe = /["']?(?:customer_name|customerName|予約者|予約名|氏名)["']?\s*[:：=]\s*["']?([^"',\n/}]{1,80})/gmu;
    while ((match = labelRe.exec(source))) addName(names, match[1]);
    if (/予約|顧客|来店履歴|アレルギー/u.test(source)) {
      var honorificRe = /((?:[一-龯々]{2,8}|[ぁ-んァ-ヶー]{2,16}|[A-Za-z][A-Za-z・･\s]{1,39}))(?:様|さん)/gu;
      while ((match = honorificRe.exec(source))) addName(names, match[1]);
    }
  }

  function collect(value, names) {
    if (typeof value === 'string') return collectText(value, names);
    if (Array.isArray(value)) return value.forEach(function (item) { collect(item, names); });
    if (!isRecord(value)) return;
    Object.keys(value).forEach(function (key) {
      if (/^(?:customer_name|customerName|reservation_name|guest_name)$/i.test(key)) {
        addName(names, value[key]);
      }
      collect(value[key], names);
    });
  }

  function sanitizeText(value, aliases) {
    var text = String(value == null ? '' : value);
    Object.keys(aliases).sort(function (a, b) { return b.length - a.length; })
      .forEach(function (name) { text = text.split(name).join(aliases[name]); });
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[メール非送信]');
    text = text.replace(/(?<!\d)(?:\+?81[-\s]?)?(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?!\d)/g, '[電話非送信]');
    text = text.replace(/([/／]\s*)アレルギー\s+(?!記載|あり|なし)[^/／\n]+/gu, '$1アレルギーあり');
    text = text.replace(/アレルギー(?:内容)?\s*[:：]\s*(?!あり|なし)[^/／\n、。]+/gu, 'アレルギーあり');
    return text;
  }

  function sanitizeValue(value, aliases, key) {
    var field = String(key || '');
    if (/^(?:customer_phone|phone|telephone|tel|email|email_address)$/i.test(field)) return null;
    if (/^(?:allergy|allergies|allergy_label|allergy_detail|allergy_details|アレルギー|アレルギー内容)$/i.test(field)) {
      return value == null || value === '' || value === false ? null : 'アレルギーあり';
    }
    if (/^(?:customer_name|customerName|reservation_name|guest_name)$/i.test(field)) {
      var name = normalizeName(value);
      return name ? (aliases[name] || '予約客') : null;
    }
    if (typeof value === 'string') return sanitizeText(value, aliases);
    if (Array.isArray(value)) return value.map(function (item) { return sanitizeValue(item, aliases, ''); });
    if (!isRecord(value)) return value;
    var result = {};
    Object.keys(value).forEach(function (nestedKey) {
      result[nestedKey] = sanitizeValue(value[nestedKey], aliases, nestedKey);
    });
    return result;
  }

  function sanitizePayload(payload) {
    var source = isRecord(payload) ? payload : {};
    var names = [];
    collect(source.systemInstruction, names);
    collect(source.salesData, names);
    collect(source.message, names);
    collect(source.chatHistory, names);
    collect(source.clarificationContext, names);
    var aliases = {};
    names.forEach(function (name, index) { aliases[name] = aliasFor(index); });
    return sanitizeValue(source, aliases, '');
  }

  global.JOURNAL_AI_PRIVACY = {
    aliasFor: aliasFor,
    sanitizePayload: sanitizePayload
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
