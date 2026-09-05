// RTL Hebrew for Slack — content script
// Fixes app.slack.com's native `dir="auto"` (first-strong-character) direction
// detection, which fails whenever a Hebrew message doesn't start with a
// Hebrew character (e.g. starts with an @mention or an English word).
// This uses whole-message majority-script detection instead.

(function () {
  'use strict';

  // Firefox keeps `chrome.*` callback-style and only promisifies `browser.*`,
  // so `await chrome.storage.local.get()` resolves to undefined there. Chromium
  // has no `browser` at all and its `chrome.*` storage does return promises —
  // so prefer `browser` where it exists and fall back to `chrome`.
  const ext = (typeof browser !== 'undefined' && browser.storage) ? browser
    : (typeof chrome !== 'undefined' ? chrome : undefined);

  // RTL scripts we react to. The Arabic script block (U+0600-06FF) is shared by
  // Arabic, Persian/Farsi, Urdu, Pashto, Kurdish (Sorani), Sindhi and Uyghur —
  // their extra letters live inside it and in the supplements below, so one set
  // of ranges covers all of them. Ranges:
  //   Hebrew U+0590-05FF, Hebrew presentation forms U+FB1D-FB4F,
  //   Arabic U+0600-06FF, Syriac U+0700-074F, Arabic Supplement U+0750-077F,
  //   Thaana U+0780-07BF (Dhivehi), NKo U+07C0-07FF,
  //   Arabic Extended-B U+0870-089F, Arabic Extended-A U+08A0-08FF,
  //   Arabic Presentation Forms-A U+FB50-FDFF, Forms-B U+FE70-FEFF.
  const RTL_RE = /[֐-׿יִ-ﭏ؀-߿ࡰ-ࣿﭐ-﷿ﹰ-﻿]/g;
  // Basic Latin + Latin-1 Supplement + Latin Extended-A letters
  const HEBREW_RE = /[֐-׿יִ-ﭏ]/g;
  const ARABIC_RE = /[؀-ۿݐ-ݿࡰ-ࣿﭐ-﷿ﹰ-﻿]/g;
  // Letters only Urdu (and Shahmukhi Punjabi) uses: TTEH, DDAL, RREH,
  // NOON GHUNNA, HEH DOACHASHMEE, HEH GOAL, YEH BARREE.
  const URDU_RE = /[ٹڈڑںھہۃےۓ]/g;
  // Letters that mark Persian/Farsi. Urdu uses these too, so this is only
  // consulted after the Urdu test: PEH, TCHEH, JEH, GAF, and the Persian forms
  // of kaf/yeh/heh that Arabic proper does not use.
  const PERSIAN_RE = /[پچژگکیۀ]/g;
  const LATIN_RE = /[A-Za-zÀ-ɏ]/g;

  // An embedded LTR run (English word etc.) to isolate so its brackets do not
  // mirror. The run is bounded by ALPHANUMERICS on both ends, so it never
  // swallows a leading/trailing neutral (space, hyphen, or bracket) that
  // belongs to the adjacent RTL text — e.g. in Hebrew "...Gorgias (bracketed
  // Hebrew)" it matches "Gorgias", not "Gorgias (". A directly-enclosing
  // bracket pair is re-added after so "(chrome extension)" keeps its parens.
  const LTR_CORE_RE = /[A-Za-z0-9](?:[^֐-׿יִ-ﭏ؀-߿ࡰ-ࣿﭐ-﷿ﹰ-﻿]*[A-Za-z0-9])?/g;
  const OPEN_BRACKET = { "(": ")", "[": "]", "{": "}" };
  const LTR_CLASS = "rtlheb-ltr";
  // Never wrap inside these — links, code, and Slack mention/broadcast pills
  // are already isolated by Slack; wrapping them can break their layout.
  const WRAP_SKIP_TAGS = { A: 1, CODE: 1, PRE: 1, BUTTON: 1 };

  const MSG_RTL_CLASS = 'rtlheb-msg';
  const COMPOSER_RTL_CLASS = 'rtlheb-composer-rtl';
  // Marks elements THIS extension modified, so re-renders and edits can be
  // cleaned up idempotently without ever touching untouched Slack nodes.
  const MARKER_ATTR = 'data-rtlheb';
  let extensionEnabled = false;

  // Hebrew families. Every face below is declared with a Hebrew-only
  // unicode-range, and the Arabic families with an Arabic-only one, so a single
  // font stack can hold one of each and the browser picks per character. That
  // is why a mixed Hebrew/Arabic/Persian message needs no per-message font
  // logic — see buildFontStack().
  const FONT_FAMILIES = {
    assistant: "'RTLHeb Assistant', sans-serif",
    rubik: "'RTLHeb Rubik', sans-serif",
    heebo: "'RTLHeb Heebo', sans-serif",
    noto: "'RTLHeb Noto Sans Hebrew', sans-serif",
    frank: "'RTLHeb Frank Ruhl Libre', serif",
    secular: "'RTLHeb Secular One', sans-serif",
    suez: "'RTLHeb Suez One', serif"
  };

  // Arabic-script families, for Arabic, Persian/Farsi, Urdu, Pashto, Kurdish
  // and Sindhi. Vazirmatn is the default because it is the standard modern
  // Persian UI face and covers Arabic properly too; Noto Nastaliq Urdu is the
  // Nastaliq style Urdu is actually written in, which no other Slack RTL
  // extension ships.
  const FONT_FAMILIES_AR = {
    vazirmatn: "'RTLHeb Vazirmatn', sans-serif",
    cairo: "'RTLHeb Cairo', sans-serif",
    naskh: "'RTLHeb Noto Naskh Arabic', serif",
    plex: "'RTLHeb IBM Plex Sans Arabic', sans-serif",
    nastaliq: "'RTLHeb Noto Nastaliq Urdu', serif"
  };

  // Secular One and Suez One are single-weight families (400 only);
  // the rest ship a true 700 so bold Hebrew isn't browser-synthesized.
  // Unicode ranges each face is limited to. Keeping them disjoint is what lets
  // the Hebrew choice and the Arabic choice live in the same font stack.
  const HEBREW_RANGE = 'U+0590-05FF, U+FB1D-FB4F, U+200C-200F, U+20AA';
  const ARABIC_RANGE = 'U+0600-06FF, U+0750-077F, U+0870-088E, U+08A0-08FF, '
    + 'U+FB50-FDFF, U+FE70-FEFF, U+200C-200F, U+2010-2011, U+204F, U+2E41, U+FDFD';

  const FONT_FACES = [
    { family: 'RTLHeb Assistant', file: 'Assistant.woff2', weight: '400', range: HEBREW_RANGE },
    { family: 'RTLHeb Assistant', file: 'Assistant700.woff2', weight: '700', range: HEBREW_RANGE },
    { family: 'RTLHeb Rubik', file: 'Rubik.woff2', weight: '400', range: HEBREW_RANGE },
    { family: 'RTLHeb Rubik', file: 'Rubik700.woff2', weight: '700', range: HEBREW_RANGE },
    { family: 'RTLHeb Heebo', file: 'Heebo.woff2', weight: '400', range: HEBREW_RANGE },
    { family: 'RTLHeb Heebo', file: 'Heebo700.woff2', weight: '700', range: HEBREW_RANGE },
    { family: 'RTLHeb Noto Sans Hebrew', file: 'NotoSansHebrew.woff2', weight: '400', range: HEBREW_RANGE },
    { family: 'RTLHeb Noto Sans Hebrew', file: 'NotoSansHebrew700.woff2', weight: '700', range: HEBREW_RANGE },
    { family: 'RTLHeb Frank Ruhl Libre', file: 'FrankRuhlLibre.woff2', weight: '400', range: HEBREW_RANGE },
    { family: 'RTLHeb Frank Ruhl Libre', file: 'FrankRuhlLibre700.woff2', weight: '700', range: HEBREW_RANGE },
    { family: 'RTLHeb Secular One', file: 'SecularOne.woff2', weight: '400', range: HEBREW_RANGE },
    { family: 'RTLHeb Suez One', file: 'SuezOne.woff2', weight: '400', range: HEBREW_RANGE },
    // Arabic-script faces. Vazirmatn, Cairo, Noto Naskh Arabic and Noto
    // Nastaliq Urdu are VARIABLE fonts — Google serves one file for every
    // weight, so each ships once with a 100-900 range instead of a 400 and a
    // 700 copy of the same bytes. IBM Plex Sans Arabic is static, hence two.
    { family: 'RTLHeb Vazirmatn', file: 'Vazirmatn.woff2', weight: '100 900', range: ARABIC_RANGE },
    { family: 'RTLHeb Cairo', file: 'Cairo.woff2', weight: '100 900', range: ARABIC_RANGE },
    { family: 'RTLHeb Noto Naskh Arabic', file: 'NotoNaskhArabic.woff2', weight: '400 700', range: ARABIC_RANGE },
    { family: 'RTLHeb IBM Plex Sans Arabic', file: 'IBMPlexSansArabic.woff2', weight: '400', range: ARABIC_RANGE },
    { family: 'RTLHeb IBM Plex Sans Arabic', file: 'IBMPlexSansArabic700.woff2', weight: '700', range: ARABIC_RANGE },
    { family: 'RTLHeb Noto Nastaliq Urdu', file: 'NotoNastaliqUrdu.woff2', weight: '400 700', range: ARABIC_RANGE }
  ];

  // A relative url() in content_scripts CSS resolves against the *host
  // page's* URL, not the extension package (confirmed live — it requested
  // app.slack.com/.../fonts/Rubik.woff2 and silently got Slack's HTML shell
  // back instead of a font). chrome.runtime.getURL() resolves correctly, so
  // the @font-face rules are injected here instead of in styles.css.
  function injectFontFaces() {
    if (!ext || !ext.runtime || !ext.runtime.getURL) return;
    // The content script can run in more than one app.slack.com frame; only
    // inject the @font-face block once per document.
    if (document.getElementById('rtlheb-fontfaces')) return;
    const rules = FONT_FACES.map(({ family, file, weight, range }) => `
@font-face {
  font-family: '${family}';
  src: url('${ext.runtime.getURL('fonts/' + file)}') format('woff2');
  font-weight: ${weight};
  font-display: swap;
  unicode-range: ${range};
}`).join('\n');
    const style = document.createElement('style');
    style.id = 'rtlheb-fontfaces';
    style.textContent = rules;
    document.head.appendChild(style);
  }
  injectFontFaces();

  // --- direction detection -------------------------------------------------

  function detectDirection(text) {
    if (!text) return null;
    const rtlCount = (text.match(RTL_RE) || []).length;
    if (rtlCount === 0) return null; // no Hebrew/Arabic present — leave this element alone
    const latinCount = (text.match(LATIN_RE) || []).length;
    return rtlCount >= latinCount ? "rtl" : "ltr";
  }

  // Pick the BCP-47 lang tag for a right-to-left block: whichever script
  // dominates. Correct lang helps screen readers pick the right voice.
  function langFor(text) {
    const he = (text.match(HEBREW_RE) || []).length;
    const ar = (text.match(ARABIC_RE) || []).length;
    if (ar <= he) return "he";
    // Arabic-script text is not necessarily Arabic. Tagging Persian or Urdu as
    // `ar` makes the browser shape it with Arabic conventions and reach for an
    // Arabic font, which renders the Persian yeh/kaf wrong and Urdu wholesale —
    // Urdu expects a Nastaliq face, not a Naskh one. Urdu is tested first
    // because Urdu also uses every Persian letter.
    if ((text.match(URDU_RE) || []).length) return "ur";
    if ((text.match(PERSIAN_RE) || []).length) return "fa";
    return "ar";
  }

  // --- messages --------------------------------------------------------------

  // Would wrapping text under this node damage Slack's own markup? Skip links,
  // code, and mention/broadcast pills — Slack already isolates those.
  function isWrapSafe(textNode, root) {
    let el = textNode.parentElement;
    while (el && el !== root.parentElement) {
      if (WRAP_SKIP_TAGS[el.tagName]) return false;
      const c = el.className;
      if (typeof c === 'string' &&
          (c.indexOf('mention') >= 0 || c.indexOf('broadcast') >= 0 ||
           c.indexOf('member_slug') >= 0 || c.indexOf(LTR_CLASS) >= 0)) return false;
      if (el === root) break;
      el = el.parentElement;
    }
    return true;
  }

  // Wrap each embedded Latin run in a <span class="rtlheb-ltr" dir="ltr"> so
  // its brackets/order render as an LTR island inside the RTL message. This
  // preserves the message's text exactly (no Unicode control chars injected)
  // and is idempotent: an already-wrapped run has no bare Latin left to match,
  // so a re-run makes no mutation and the observer settles after one pass.
  function wrapLtrRuns(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!/[A-Za-z]/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        return isWrapSafe(n, block) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const textNode of targets) {
      const text = textNode.nodeValue;
      // Collect the [start,end) ranges to isolate. Each is an alphanumeric-
      // bounded run that contains at least one Latin letter, optionally grown
      // by one directly-enclosing bracket pair.
      LTR_CORE_RE.lastIndex = 0;
      const ranges = [];
      let m, last = 0;
      while ((m = LTR_CORE_RE.exec(text))) {
        if (m[0] === '') { LTR_CORE_RE.lastIndex++; continue; }
        if (!/[A-Za-z]/.test(m[0])) continue; // pure numbers: leave to native bidi
        let s = m.index, e = m.index + m[0].length;
        const before = text[s - 1], after = text[e];
        if (before && OPEN_BRACKET[before] === after) { s -= 1; e += 1; }
        if (s < last) s = last; // never overlap the previous range
        ranges.push([s, e]);
      }
      if (!ranges.length) continue;
      const frag = document.createDocumentFragment();
      last = 0;
      for (const [s, e] of ranges) {
        if (s > last) frag.appendChild(document.createTextNode(text.slice(last, s)));
        const span = document.createElement('span');
        span.className = LTR_CLASS;
        span.setAttribute('dir', 'ltr');
        span.textContent = text.slice(s, e);
        frag.appendChild(span);
        last = e;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  // Undo wrapping: replace each .rtlheb-ltr span with its plain text and merge
  // adjacent text nodes. Used when a block stops being Hebrew/Arabic-dominant.
  function unwrapLtrRuns(block) {
    const spans = block.querySelectorAll('.' + LTR_CLASS);
    spans.forEach((span) => {
      span.replaceWith(document.createTextNode(span.textContent));
    });
    if (spans.length) block.normalize();
  }

  // The ONLY node this extension ever styles in the message list is the
  // .p-rich_text_block — the narrowest container that holds just the message
  // text (same node in the channel pane and the thread pane; it contains no
  // author, timestamp, avatar, reactions, or thread controls). Ancestors and
  // siblings are never mutated, so day dividers, gutters, headers, and
  // English-only replies are untouched by construction.
  function processMessageBlock(block) {
    if (!extensionEnabled) return;
    if (!block || !block.classList || !block.classList.contains('p-rich_text_block')) return;
    const dir = detectDirection(block.textContent);

    if (dir === 'rtl') {
      block.classList.add(MSG_RTL_CLASS);
      block.setAttribute('dir', 'rtl');
      block.setAttribute('lang', langFor(block.textContent));
      block.setAttribute(MARKER_ATTR, 'msg');
      wrapLtrRuns(block);
    } else if (block.hasAttribute(MARKER_ATTR)) {
      unwrapLtrRuns(block);
      // We modified this block before, but its text is no longer
      // Hebrew/Arabic-dominant (edited message, or Slack recycled the DOM
      // node for a different message) — restore it to native Slack state.
      // Slack natively sets dir="auto" on these, so restore that rather than
      // dropping the attribute entirely (matches the composer restore path).
      block.classList.remove(MSG_RTL_CLASS);
      block.setAttribute('dir', 'auto');
      block.removeAttribute('lang');
      block.removeAttribute(MARKER_ATTR);
    }
    // Blocks we never touched stay untouched.
  }

  function processWithinNode(node) {
    if (!(node instanceof Element)) return;
    if (node.classList && node.classList.contains('p-rich_text_block')) {
      processMessageBlock(node);
    }
    // Slack's virtualizer sometimes keeps a .p-rich_text_block element in
    // place and swaps only its inner sections — then the mutation's added
    // nodes are those children, and the block itself (possibly carrying stale
    // RTL from a previous message) is neither self nor a descendant here.
    // Re-check the nearest ancestor block so recycled nodes get re-evaluated.
    const ancestorBlock = node.closest ? node.closest('.p-rich_text_block') : null;
    if (ancestorBlock) processMessageBlock(ancestorBlock);
    const nested = node.querySelectorAll ? node.querySelectorAll('.p-rich_text_block') : [];
    nested.forEach(processMessageBlock);
  }

  function initialScan() {
    document.querySelectorAll('.p-rich_text_block').forEach(processMessageBlock);
  }

  const messageObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(processWithinNode);
      } else if (mutation.type === 'characterData') {
        const parent = mutation.target.parentElement;
        const block = parent && parent.closest ? parent.closest('.p-rich_text_block') : null;
        if (block) processMessageBlock(block);
      }
    }
  });

  messageObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // --- composer (message input) ---------------------------------------------

  function isComposerElement(el) {
    return !!(el && el.matches && (el.matches('[data-qa="texty_input"]') || el.closest('[data-qa="texty_input"]')));
  }

  function applyComposerDirection(el) {
    if (!extensionEnabled) return;
    const editor = el.matches('[data-qa="texty_input"]') ? el : el.closest('[data-qa="texty_input"]');
    if (!editor) return;
    const dir = detectDirection(editor.innerText || editor.textContent);
    if (dir === 'rtl') {
      editor.setAttribute('dir', 'rtl');
      editor.classList.add(COMPOSER_RTL_CLASS);
      editor.setAttribute(MARKER_ATTR, 'composer');
    } else if (editor.hasAttribute(MARKER_ATTR)) {
      // Restore Slack's native dir="auto" (never pin ltr — that would
      // override Slack's own first-character detection for other users' drafts).
      editor.setAttribute('dir', 'auto');
      editor.classList.remove(COMPOSER_RTL_CLASS);
      editor.removeAttribute(MARKER_ATTR);
    }
  }

  // Delegated listeners survive Slack's SPA remounting the composer on
  // channel switch / opening a thread — no need to re-bind per instance.
  document.addEventListener('input', (e) => {
    if (isComposerElement(e.target)) applyComposerDirection(e.target);
  }, true);

  document.addEventListener('focusin', (e) => {
    if (isComposerElement(e.target)) applyComposerDirection(e.target);
  }, true);

  // --- settings (font / font size), applied live via CSS custom properties --

  function restoreNativeSlack() {
    const messageBlocks = new Set();
    document.querySelectorAll('.p-rich_text_block.' + MSG_RTL_CLASS + ', .p-rich_text_block[' + MARKER_ATTR + '="msg"]').forEach((block) => {
      messageBlocks.add(block);
    });
    document.querySelectorAll('.p-rich_text_block .' + LTR_CLASS).forEach((span) => {
      const block = span.closest('.p-rich_text_block');
      if (block) messageBlocks.add(block);
    });
    messageBlocks.forEach((block) => {
      unwrapLtrRuns(block);
      block.classList.remove(MSG_RTL_CLASS);
      block.setAttribute('dir', 'auto');
      block.removeAttribute('lang');
      block.removeAttribute(MARKER_ATTR);
    });

    document.querySelectorAll('[data-qa="texty_input"].' + COMPOSER_RTL_CLASS + ', [data-qa="texty_input"][' + MARKER_ATTR + '="composer"]').forEach((editor) => {
      editor.setAttribute('dir', 'auto');
      editor.classList.remove(COMPOSER_RTL_CLASS);
      editor.removeAttribute(MARKER_ATTR);
    });

    const root = document.documentElement;
    root.style.removeProperty('--rtlheb-font');
    root.style.removeProperty('--rtlheb-font-size');
  }

  // One stack holds the Hebrew choice AND the Arabic-script choice. Because the
  // two sets of @font-face rules declare disjoint unicode-ranges, the browser
  // resolves each character to the right family on its own — so a channel with
  // Hebrew, Arabic and Persian messages side by side needs no per-message work,
  // and a message mixing them renders every script in its chosen font.
  function buildFontStack(settings) {
    const he = settings && settings.font ? FONT_FAMILIES[settings.font] : null;
    const ar = settings && settings.fontArabic ? FONT_FAMILIES_AR[settings.fontArabic] : null;
    if (!he && !ar) return null;
    const names = [];
    // Named families first, generic fallback last — a generic keyword swallows
    // everything after it.
    [ar, he].forEach((entry) => {
      if (!entry) return;
      names.push(entry.split(',')[0].trim());
    });
    const generic = (he || ar).split(',').pop().trim();
    names.push(generic);
    return names.join(', ');
  }

  function applySettings(settings) {
    const root = document.documentElement;
    if (!extensionEnabled) {
      root.style.removeProperty('--rtlheb-font');
      root.style.removeProperty('--rtlheb-font-size');
      return;
    }
    const stack = buildFontStack(settings);
    if (stack) {
      root.style.setProperty('--rtlheb-font', stack);
    } else {
      root.style.removeProperty('--rtlheb-font');
    }

    const size = settings && settings.fontSize ? parseInt(settings.fontSize, 10) : null;
    if (size && !Number.isNaN(size)) {
      root.style.setProperty('--rtlheb-font-size', size + 'px');
    } else {
      root.style.removeProperty('--rtlheb-font-size');
    }
  }

  function applyEnabledState(settings) {
    const nextEnabled = !settings || settings.enabled !== false;
    extensionEnabled = nextEnabled;

    if (!nextEnabled) {
      restoreNativeSlack();
      return;
    }

    applySettings(settings);
    initialScan();
    document.querySelectorAll('[data-qa="texty_input"]').forEach(applyComposerDirection);
  }

  async function refreshSettings() {
    try {
      const settings = await ext.storage.local.get(['enabled', 'font', 'fontArabic', 'fontSize']);
      applyEnabledState(settings);
    } catch (error) {
      console.error('Could not load RTL for Slack settings:', error);
      applyEnabledState({ enabled: true });
    }
  }

  if (ext && ext.storage) {
    // storage.local (not sync) — settings never leave this device, so the
    // "no data leaves your browser" promise is literally true.
    void refreshSettings();
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes.enabled && !changes.font && !changes.fontArabic && !changes.fontSize) return;
      void refreshSettings();
    });
  } else {
    applyEnabledState({ enabled: true });
  }
})();
