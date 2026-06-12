const DEFAULT_FONT_OPTIONS = [
  { value: 'Microsoft YaHei, PingFang SC, sans-serif', label: '微软雅黑' },
  { value: 'SimSun, STSong, serif', label: '宋体' },
  { value: 'SimHei, STHeiti, sans-serif', label: '黑体' },
  { value: 'KaiTi, STKaiti, serif', label: '楷体' },
  { value: 'Arial, sans-serif', label: 'Arial' },
];

let systemFontOptionsCache = null;

export function getFontOptionsHTML(current) {
  const currentValue = String(current || '');
  const currentKey = _normalizeFontValue(currentValue);
  const currentPrimaryKey = _normalizeFontValue(_getPrimaryFontName(currentValue));

  return _getFontOptions(currentValue).map((option) => {
    const valueKey = _normalizeFontValue(option.value);
    const valuePrimaryKey = _normalizeFontValue(_getPrimaryFontName(option.value));
    const selected = currentKey && (
      valueKey === currentKey || (currentPrimaryKey && valuePrimaryKey === currentPrimaryKey)
    ) ? ' selected' : '';

    return `<option value="${_escapeHTML(option.value)}"${selected}>${_escapeHTML(option.label)}</option>`;
  }).join('');
}

function _getFontOptions(current) {
  const options = [];
  const seen = new Set();
  const addOption = (value, label = value) => {
    const normalizedValue = String(value || '').trim();
    const normalizedLabel = String(label || normalizedValue).trim();
    if (!normalizedValue) return;

    const key = _normalizeFontValue(_getPrimaryFontName(normalizedValue));
    if (seen.has(key)) return;

    seen.add(key);
    options.push({ value: normalizedValue, label: normalizedLabel });
  };

  DEFAULT_FONT_OPTIONS.forEach((option) => addOption(option.value, option.label));
  if (current) addOption(current, current);
  _getSystemFontOptions().forEach((option) => addOption(option.value, option.label));

  return options;
}

function _getSystemFontOptions() {
  if (systemFontOptionsCache) return systemFontOptionsCache;

  try {
    const fonts = typeof window.getSystemFonts === 'function' ? window.getSystemFonts() : [];
    systemFontOptionsCache = Array.isArray(fonts)
      ? fonts.map((font) => String(font || '').trim()).filter(Boolean).map((font) => ({ value: font, label: font }))
      : [];
  } catch (e) {
    console.error('[fonts] 获取系统字体失败:', e);
    systemFontOptionsCache = [];
  }

  return systemFontOptionsCache;
}

function _getPrimaryFontName(value) {
  return String(value || '').split(',')[0].replace(/^['"]|['"]$/g, '').trim();
}

function _normalizeFontValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function _escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
