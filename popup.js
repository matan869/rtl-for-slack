(function () {
  'use strict';

  // See content.js — Firefox only promisifies `browser.*`, Chromium only has
  // `chrome.*`. Same pick, so one source runs on both.
  const ext = (typeof browser !== 'undefined' && browser.storage) ? browser
    : (typeof chrome !== 'undefined' ? chrome : undefined);

  const enabledInput = document.getElementById('enabled');
  const enabledStatus = document.getElementById('enabledStatus');
  const settingsControls = document.getElementById('settingsControls');
  const fontSelect = document.getElementById('font');
  const fontArSelect = document.getElementById('fontArabic');
  const sizeInput = document.getElementById('fontSize');
  const sizeOut = document.getElementById('fontSizeOut');
  const preview = document.getElementById('preview');

  const DEFAULT_SIZE = 15;

  // Arabic-script faces are declared with an Arabic-only unicode-range and the
  // Hebrew ones with a Hebrew-only range, so the preview can name both at once
  // and each half of the sample string picks up its own font.
  const FONT_STACKS_AR = {
    default: '',
    vazirmatn: "'RTLHeb Vazirmatn'",
    cairo: "'RTLHeb Cairo'",
    naskh: "'RTLHeb Noto Naskh Arabic'",
    plex: "'RTLHeb IBM Plex Sans Arabic'",
    nastaliq: "'RTLHeb Noto Nastaliq Urdu'"
  };

  const FONT_STACKS = {
    default: '',
    assistant: "'RTLHeb Assistant', sans-serif",
    rubik: "'RTLHeb Rubik', sans-serif",
    heebo: "'RTLHeb Heebo', sans-serif",
    noto: "'RTLHeb Noto Sans Hebrew', sans-serif",
    frank: "'RTLHeb Frank Ruhl Libre', serif",
    secular: "'RTLHeb Secular One', sans-serif",
    suez: "'RTLHeb Suez One', serif"
  };

  function updatePreview() {
    const size = sizeInput.value;
    const he = FONT_STACKS[fontSelect.value] || '';
    const ar = FONT_STACKS_AR[fontArSelect.value] || '';
    const names = [];
    if (ar) names.push(ar);
    if (he) names.push(he.split(',')[0].trim());
    if (names.length) names.push((he || 'sans-serif').split(',').pop().trim());
    preview.style.fontFamily = names.join(', ');
    preview.style.fontSize = size + 'px';
    sizeOut.textContent = size + 'px';
  }

  function updateEnabledUI() {
    const enabled = enabledInput.checked;
    enabledStatus.textContent = enabled ? 'On' : 'Off';
    settingsControls.disabled = !enabled;
  }

  async function saveSettings() {
    try {
      await ext.storage.local.set({
        enabled: enabledInput.checked,
        font: fontSelect.value === 'default' ? '' : fontSelect.value,
        fontArabic: fontArSelect.value === 'default' ? '' : fontArSelect.value,
        fontSize: sizeInput.value
      });
    } catch (error) {
      console.error('Could not save RTL for Slack settings:', error);
    }
  }

  async function initialize() {
    try {
      const settings = await ext.storage.local.get(['enabled', 'font', 'fontArabic', 'fontSize']);
      enabledInput.checked = settings.enabled !== false;
      fontSelect.value = settings.font || 'default';
      fontArSelect.value = settings.fontArabic || 'default';
      sizeInput.value = settings.fontSize || DEFAULT_SIZE;
      updateEnabledUI();
      updatePreview();
    } catch (error) {
      console.error('Could not load RTL for Slack settings:', error);
      enabledInput.checked = true;
      sizeInput.value = DEFAULT_SIZE;
      updateEnabledUI();
      updatePreview();
    }
  }

  enabledInput.addEventListener('change', () => {
    updateEnabledUI();
    void saveSettings();
  });

  [fontSelect, fontArSelect].forEach((el) => el.addEventListener('change', () => {
    updatePreview();
    void saveSettings();
  }));

  sizeInput.addEventListener('input', () => {
    updatePreview();
    void saveSettings();
  });

  void initialize();
})();
