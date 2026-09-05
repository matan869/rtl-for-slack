// Runs the REAL content.js against a Slack-shaped DOM in Chromium, so the
// direction/lang/wrap logic is exercised the way the extension runs it —
// without loading an unpacked extension (Chrome's folder picker can't be
// driven) and without touching a live Slack workspace.
import { chromium } from '/usr/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('✓', name); }
  else { fail++; console.log('✗', name, extra); }
};

// --- static checks -----------------------------------------------------------
for (const m of content.matchAll(/file:\s*'([^']+\.woff2)'/g)) {
  ok(`font file exists: ${m[1]}`, fs.existsSync(path.join(ROOT, 'fonts', m[1])));
}
ok('manifest ships fonts to the page', JSON.stringify(manifest.web_accessible_resources).includes('fonts/*.woff2'));
ok('no host permission beyond Slack', JSON.stringify(manifest.host_permissions) === '["https://app.slack.com/*"]');
ok('only the storage permission', JSON.stringify(manifest.permissions) === '["storage"]');

const MSG = (html) => `<div class="p-rich_text_block" dir="auto"><div class="p-rich_text_section">${html}</div></div>`;
const page_html = `<!doctype html><meta charset="utf-8"><style>${styles}</style><body>
${MSG('שלום לכולם, מה קורה')}
${MSG('مرحبا بالجميع كيف حالكم')}
${MSG('سلام بچه‌ها چطورید')}
${MSG('السلام علیکم آپ کیسے ہیں')}
${MSG('@Estefy Melo היי, בדקתי את זה ב-Gorgias (לא דרך הבוט) והכל תקין')}
${MSG('Hello everyone, this is a plain English message')}
${MSG('نص عربي مع كلمة English بداخله وبعدها تكملة عربية طويلة')}
<div data-qa="texty_input" contenteditable="true" class="ql-editor">שלום</div>
</body>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(page_html);
// Stub the extension API: enabled, with a font chosen for BOTH scripts.
await page.addInitScript(() => {});
await page.evaluate(() => {
  const store = { enabled: true, font: 'assistant', fontArabic: 'vazirmatn', fontSize: '16' };
  window.chrome = {
    runtime: { getURL: (p) => 'chrome-extension://test/' + p },
    storage: {
      local: { get: async (keys) => Object.fromEntries(keys.map((k) => [k, store[k]])) },
      onChanged: { addListener() {} },
    },
  };
});
await page.addScriptTag({ content });
await page.waitForTimeout(400);

const blocks = await page.evaluate(() => [...document.querySelectorAll('.p-rich_text_block')].map((b) => ({
  text: b.textContent.slice(0, 28),
  dir: getComputedStyle(b).direction,
  lang: b.getAttribute('lang'),
  rtlClass: b.classList.contains('rtlheb-msg'),
  ltrRuns: [...b.querySelectorAll('.rtlheb-ltr')].map((s) => s.textContent),
  fontFamily: getComputedStyle(b).fontFamily,
})));

const [he, ar, fa, ur, mixed, en, arEn] = blocks;
ok('Hebrew message goes rtl', he.dir === 'rtl' && he.rtlClass);
ok('Hebrew tagged lang=he', he.lang === 'he', he.lang);
ok('Arabic message goes rtl', ar.dir === 'rtl' && ar.rtlClass);
ok('Arabic tagged lang=ar', ar.lang === 'ar', ar.lang);
ok('Persian tagged lang=fa (not ar)', fa.lang === 'fa', fa.lang);
ok('Persian message goes rtl', fa.dir === 'rtl');
ok('Urdu tagged lang=ur (not ar)', ur.lang === 'ur', ur.lang);
ok('Urdu message goes rtl', ur.dir === 'rtl');
ok('Hebrew starting with @mention still rtl', mixed.dir === 'rtl');
ok('Latin run isolated, bracket left with the Hebrew',
  mixed.ltrRuns.includes('Gorgias') && !mixed.ltrRuns.some((r) => r.includes('(')),
  JSON.stringify(mixed.ltrRuns));
ok('plain English message untouched', !en.rtlClass && en.lang === null);
ok('Arabic-majority with an English word still rtl', arEn.dir === 'rtl');
ok('English word inside Arabic is isolated', arEn.ltrRuns.includes('English'), JSON.stringify(arEn.ltrRuns));

// Font stack must name the Arabic family AND the Hebrew family, so the
// disjoint unicode-ranges can each claim their own characters.
ok('font stack carries both scripts',
  /Vazirmatn/.test(he.fontFamily) && /Assistant/.test(he.fontFamily), he.fontFamily);

const faces = await page.evaluate(() => {
  const el = document.getElementById('rtlheb-fontfaces');
  return el ? el.textContent : '';
});
ok('Hebrew faces keep a Hebrew-only unicode-range',
  /RTLHeb Assistant[\s\S]*?unicode-range: U\+0590-05FF/.test(faces));
ok('Arabic faces get an Arabic unicode-range',
  /RTLHeb Vazirmatn[\s\S]*?unicode-range: U\+0600-06FF/.test(faces));
ok('no Hebrew range leaks onto an Arabic face',
  !/RTLHeb (Vazirmatn|Cairo|Noto Naskh Arabic|Noto Nastaliq Urdu|IBM Plex Sans Arabic)[\s\S]{0,200}?unicode-range: U\+0590/.test(faces));

const comp = await page.evaluate(() => {
  const c = document.querySelector('[data-qa="texty_input"]');
  return { cls: c.classList.contains('rtlheb-composer-rtl'), bidi: getComputedStyle(c).unicodeBidi };
});
ok('composer gets the rtl class', comp.cls);
ok('composer uses plaintext bidi', comp.bidi === 'plaintext', comp.bidi);

// --- locales -----------------------------------------------------------------
const LOC = path.join(ROOT, '_locales');
const locales = fs.readdirSync(LOC).sort();
ok('default_locale is present in _locales', locales.includes(manifest.default_locale), locales.join(','));
const enMsgs = JSON.parse(fs.readFileSync(path.join(LOC, manifest.default_locale, 'messages.json'), 'utf8'));
for (const loc of locales) {
  const m = JSON.parse(fs.readFileSync(path.join(LOC, loc, 'messages.json'), 'utf8'));
  const missing = Object.keys(enMsgs).filter((k) => !m[k] || !m[k].message);
  ok(`${loc}: every message key present`, missing.length === 0, missing.join(','));
  ok(`${loc}: store name within 75 chars`, m.extName.message.length <= 75, String(m.extName.message.length));
  ok(`${loc}: store summary within 132 chars`, m.extDesc.message.length <= 132, String(m.extDesc.message.length));
}
// The manifest must reference the messages, not hard-coded English.
ok('manifest name is localized', manifest.name === '__MSG_extName__', manifest.name);
ok('manifest description is localized', manifest.description === '__MSG_extDesc__', manifest.description);
// Every data-i18n key in the popup must exist, or the element renders blank.
const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const keys = [...popupHtml.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
ok('popup uses i18n keys', keys.length >= 10, String(keys.length));
ok('every popup i18n key exists in en', keys.every((k) => enMsgs[k]), keys.filter((k) => !enMsgs[k]).join(','));

// --- popup renders in every locale ------------------------------------------
for (const loc of locales) {
  const msgs = JSON.parse(fs.readFileSync(path.join(LOC, loc, 'messages.json'), 'utf8'));
  const pop = await browser.newPage({ viewport: { width: 340, height: 620 } });
  await pop.addInitScript(([m, l]) => {
    window.chrome = {
      i18n: { getMessage: (k) => (m[k] ? m[k].message : ''), getUILanguage: () => l },
      storage: { local: { get: async () => ({ enabled: true }), set: async () => {} }, onChanged: { addListener() {} } },
    };
  }, [msgs, loc]);
  await pop.goto('file://' + path.join(ROOT, 'popup.html'));
  await pop.waitForTimeout(250);
  const info = await pop.evaluate(() => ({
    blanks: [...document.querySelectorAll('[data-i18n]')].filter((e) => !e.textContent.trim()).map((e) => e.dataset.i18n),
    dir: document.documentElement.dir || 'ltr',
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  ok(`${loc}: no blank popup strings`, info.blanks.length === 0, info.blanks.join(','));
  ok(`${loc}: popup direction`, info.dir === (loc === 'en' ? 'ltr' : 'rtl'), info.dir);
  ok(`${loc}: popup does not overflow horizontally`, !info.overflowX);
  await pop.screenshot({ path: `/tmp/popup-${loc}.png` });
  await pop.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
