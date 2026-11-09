import { eventBus } from '../index.js';
import { SIDE_PANEL_LAYOUT_KEY, SIDE_PANEL_LAYOUTS } from './SidePanelTabs.js';
import { THEME_CHOICES, applyThemeChoice, getThemeChoice } from '../utils/theme.js';
import { updateCategories, CHANGELOG, PLATFORMS, getAppVersion } from '@moruteaven/img-toolbox_changelog';
import { escapeHTML, escapeAttr } from '../utils/helpers.js';
import IdentityClient from '../identity/IdentityClient.js';
import {
  AI_CONFIG_FIELDS,
  AI_CONFIG_STATUS,
  AI_SERVICE_PRESETS,
  getAiConfig,
  getAiConfigStatus,
  getAiBaseUrlIssue,
  setAiConfigField,
  maskApiKey,
  listProviders,
  addProvider,
  updateProvider,
  removeProvider,
  setProviderKey,
  addModel,
  removeModel,
  getActiveSelection,
  setActiveSelection
} from '../ai/AI_CONFIG.js';
import { testConnection as testAiConnection } from '../ai/OpenAiCompatProvider.js';

/**
 * 读取平台标识（全局变量嗅探的回退实现）。
 *
 * 仅在没有 HostAdapter 时使用（例如独立渲染）。正常路径一律走
 * HostAdapter.platform.id。
 *
 * 这里不再嗅探 window.utools / window.ztools：ZTools 环境下 window.utools
 * 可能是 uTools API 的别名，会把 ZTools 误判成 uTools；而且宿主一旦启用
 * contextIsolation，宿主对象只存在于 preload 世界，页面侧读到的恒为
 * undefined，继续嗅探只会给出错误结论。平台信息一律由 HostAdapter 注入。
 * @returns {string|null}
 */
function inferPlatformFromGlobals() {
  return null;
}

/**
 * 把平台标识拆成多个可比较的标记。
 * HostAdapter.platform.id 使用 'utools' / 'ztools'；宿主自报名可能返回
 * 'uTools' / 'ZTools'，本函数统一归一化为小写标记集合。
 * @param {*} value
 * @returns {string[]}
 */
function toPlatformTokens(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) {
    return [];
  }
  return Array.from(new Set(text.split(/[^a-z0-9]+/).filter(Boolean)));
}

/**
 * 检查更新项是否应在当前平台显示
 * @param {null|string[]} platforms - 平台限制 (null=所有平台, ['utools']=仅utools等)
 * @param {*} currentPlatform - 当前平台标识（HostAdapter.platform.id）
 * @returns {boolean} 是否应显示
 */
function shouldShowForCurrentPlatform(platforms, currentPlatform) {
  if (platforms === null || platforms === undefined) {
    return true;
  }
  if (!Array.isArray(platforms)) {
    return true;
  }

  const current = currentPlatform || inferPlatformFromGlobals();
  if (!current) {
    return false;
  }

  const tokens = toPlatformTokens(current);
  return platforms.some((platform) => {
    const wanted = toPlatformTokens(platform);
    return wanted.length > 0 && wanted.every((token) => tokens.includes(token));
  });
}

export const EDITOR_BARS_LAYOUT_KEY = 'image-toolbox-editor-bars-layout';
export const EDITOR_BARS_LAYOUTS = {
  PRESETS_TOP: 'presets-top',
  STATUS_TOP: 'status-top'
};

export const EDITOR_SIDE_PANEL_POSITION_KEY = 'image-toolbox-editor-side-panel-position';
export const EDITOR_SIDE_PANEL_POSITIONS = {
  RIGHT: 'right',
  LEFT: 'left'
};

export const TOOLBAR_LABELS_VISIBLE_KEY = 'image-toolbox-toolbar-labels-visible';
export const TOOLBAR_LABELS_VISIBLE = {
  ON: 'on',
  OFF: 'off'
};

export const TOOLBAR_COLLAPSED_KEY = 'image-toolbox-toolbar-collapsed';
export const TOOLBAR_COLLAPSED = {
  EXPANDED: 'expanded',
  COLLAPSED: 'collapsed'
};

export const TOOLBAR_TOGGLE_VISIBLE_KEY = 'image-toolbox-toolbar-toggle-visible';
export const TOOLBAR_TOGGLE_VISIBLE = {
  ON: 'on',
  OFF: 'off'
};

export const TOOLBAR_HISTORY_LAYOUT_KEY = 'image-toolbox-toolbar-history-layout';
export const TOOLBAR_HISTORY_LAYOUT = {
  COMPACT: 'compact',
  STACKED: 'stacked'
};

/** 账户中心的全部分区（导航项与 `account:open` 直达目标共用）。 */
const ACCOUNT_SECTIONS = ['mine', 'settings', 'ai', 'updates', 'about'];

const VALID_EDITOR_BARS_LAYOUTS = new Set(Object.values(EDITOR_BARS_LAYOUTS));
const VALID_EDITOR_SIDE_PANEL_POSITIONS = new Set(Object.values(EDITOR_SIDE_PANEL_POSITIONS));
const VALID_TOOLBAR_LABELS_VISIBLE = new Set(Object.values(TOOLBAR_LABELS_VISIBLE));
const VALID_TOOLBAR_COLLAPSED = new Set(Object.values(TOOLBAR_COLLAPSED));
const VALID_TOOLBAR_TOGGLE_VISIBLE = new Set(Object.values(TOOLBAR_TOGGLE_VISIBLE));
const VALID_TOOLBAR_HISTORY_LAYOUT = new Set(Object.values(TOOLBAR_HISTORY_LAYOUT));

/**
 * Account page UI component.
 * Opens from the avatar into a standalone page with side navigation.
 */
class AccountPage {
  constructor(containerEl, editorEl, sidePanelTabs, host = null) {
    this._el = containerEl;
    this._editorEl = editorEl;
    this._sidePanelTabs = sidePanelTabs;
    this._host = host;
    this._activeSection = 'mine';
    this._user = this._getHostUser();
    this._eventBusUnsubscribers = [];
    this._identity = new IdentityClient();
    this._profile = null;
    this._profileLoading = false;
    this._nicknameEditing = false;
    this._magicLinkEmail = '';
    this._magicLinkSending = false;
    // AI 配置页当前正在编辑的提供商（master-detail 左侧选中项）
    this._aiProviderId = null;

    // 初始化 SDK（异步，不阻塞渲染）
    this._identity.init().then(() => {
      // 初始化后重新渲染，更新登录状态
      this._render();
      if (this._identity.isAuthenticated() && !this._profile) {
        this._loadProfile();
      }
    }).catch((e) => {
      console.warn('[AccountPage] Identity SDK 初始化失败:', e);
    });

    this._render();
    this._bindEvents();
  }

  /**
   * 打开账户中心。
   *
   * 支持从编辑器其它面板直达某个分区（如 AI 属性面板的「打开 AI 配置」
   * 按钮会 emit account:open + { section: 'ai' }），避免用户还要自己
   * 记住「头像 → AI 配置」的两层路径。
   * @param {{section?:string}} [payload]
   */
  open(payload = {}) {
    const section = payload && typeof payload === 'object' ? payload.section : '';
    if (ACCOUNT_SECTIONS.includes(section)) {
      this._activeSection = section;
    }
    this._user = this._getHostUser();
    this._render();
    this._editorEl?.classList.add('hidden');
    this._el?.classList.remove('hidden');
    // 打开时尝试加载档案（SDK 初始化后）
    this._identity.init().then(() => {
      if (this._identity.isAuthenticated() && !this._profile) {
        this._loadProfile();
      }
    }).catch(() => {});
  }

  close() {
    this._el?.classList.add('hidden');
    this._editorEl?.classList.remove('hidden');
    // 账户页里可以改 AI 配置（服务商/地址/模型）。属性面板的 AI 区块
    // 在渲染时就把「是否已就绪」写进 HTML，不重渲染会一直显示旧结论——
    // 用户配完地址回到编辑器，面板仍在说「尚未配置」，只能靠切工具刷新。
    eventBus.emit('tool:propertiesChanged');
  }

  _render() {
    if (!this._el) {
      return;
    }

    const sectionTitle = this._getSectionTitle(this._activeSection);
    this._el.innerHTML = `
      <div class="account-page__shell">
        <aside class="account-page__sidebar">
          <div class="account-page__brand">
            <div class="account-page__brand-mark">
              <img class="account-page__brand-logo" src="../logo.png" alt="图片工具箱" draggable="false">
            </div>
            <div>
              <div class="account-page__brand-title">图片工具箱</div>
              <div class="account-page__brand-subtitle">账户中心</div>
            </div>
          </div>

          <nav class="account-page__nav" aria-label="账户导航">
            ${this._renderNavItem('mine', '我的')}
            ${this._renderNavItem('settings', '设置')}
            ${this._renderNavItem('ai', 'AI 配置')}
            ${this._renderNavItem('updates', '更新记录')}
            ${this._renderNavItem('about', '关于')}
          </nav>

          <button class="account-page__back" type="button" data-action="back">返回编辑器</button>
        </aside>

        <main class="account-page__main">
          <header class="account-page__header">
            <div>
              <div class="account-page__eyebrow">账户中心</div>
              <h1>${this._escapeHTML(sectionTitle)}</h1>
            </div>
            <div class="account-page__header-actions">
              ${this._activeSection === 'updates' ? '<button class="account-page__header-back" type="button" data-action="copy-updates">复制更新日志</button>' : ''}
              <button class="account-page__header-back" type="button" data-action="back">返回编辑器</button>
            </div>
          </header>

          <section class="account-page__content">
            ${this._renderSection()}
          </section>
        </main>
      </div>
    `;
  }

  _bindEvents() {
    if (!this._el) {
      return;
    }

    this._eventBusUnsubscribers.push(
      eventBus.on('account:open', (payload) => this.open(payload))
    );

    this._el.addEventListener('click', (e) => {
      const navItem = this._closest(e.target, '[data-section]');
      if (navItem) {
        this._activeSection = navItem.getAttribute('data-section');
        this._nicknameEditing = false;
        this._render();
        return;
      }

      const action = this._closest(e.target, '[data-action]')?.getAttribute('data-action');
      if (action === 'back') {
        this.close();
        return;
      }

      if (action === 'copy-updates') {
        this._copyUpdates();
        return;
      }

      const externalUrl = this._closest(e.target, '[data-external-url]')?.getAttribute('data-external-url');
      if (externalUrl) {
        e.preventDefault();
        this._openExternalUrl(externalUrl);
        return;
      }

      // ── 设置项：统一分段选择控件（分组行式布局） ──
      // 全部设置项共用一个 data-setting-choice 入口，
      // 由 _applySetting 的映射表分发到对应 setter，避免逐项维护分支。
      const settingChoice = this._closest(e.target, '[data-setting-choice]');
      if (settingChoice) {
        const setting = settingChoice.getAttribute('data-setting-choice');
        const value = settingChoice.getAttribute('data-value');
        this._applySetting(setting, value);
        this._render();
        return;
      }

      // ── AI 配置：提供商 / 模型 ──
      const providerOpen = this._closest(e.target, '[data-ai-provider-open]')?.getAttribute('data-ai-provider-open');
      if (providerOpen) {
        this._aiProviderId = providerOpen;
        this._render();
        return;
      }

      const providerAddPreset = this._closest(e.target, '[data-ai-provider-add]')?.getAttribute('data-ai-provider-add');
      if (providerAddPreset) {
        const preset = AI_SERVICE_PRESETS.find((item) => item.id === providerAddPreset);
        if (preset) {
          // 新建后直接切到该提供商的详情，省去用户再点一次左侧列表
          const created = addProvider({ label: preset.label, baseUrl: preset.baseUrl });
          this._aiProviderId = created.id;
          this._render();
        }
        return;
      }

      if (this._closest(e.target, '[data-ai-provider-add-custom]')) {
        const label = this._el?.querySelector('[data-ai-new-provider-label]')?.value || '';
        const url = this._el?.querySelector('[data-ai-new-provider-url]')?.value || '';
        // 服务地址是必填项：允许建一个没有地址的提供商，只会产出
        // 「模型下拉里能选、面板却报未配置」的坏配置（历史缺陷）。
        // 判定与保存/执行同源：本机与局域网地址允许 http。
        const urlIssue = getAiBaseUrlIssue(url);
        if (urlIssue === AI_CONFIG_STATUS.NO_BASE_URL) {
          eventBus.emit('toast:show', { message: '请填写服务地址', type: 'error' });
          return;
        }
        if (urlIssue) {
          eventBus.emit('toast:show', {
            message: '公网地址需要以 https:// 开头（本机或局域网地址可用 http://）',
            type: 'error'
          });
          return;
        }
        const created = addProvider({ label, baseUrl: url });
        this._aiProviderId = created.id;
        this._render();
        return;
      }

      const providerRemove = this._closest(e.target, '[data-ai-provider-remove]')?.getAttribute('data-ai-provider-remove');
      if (providerRemove) {
        removeProvider(providerRemove);
        if (this._aiProviderId === providerRemove) {
          this._aiProviderId = null;
        }
        this._render();
        eventBus.emit('toast:show', { message: '提供商已删除', type: 'success' });
        return;
      }

      const modelAdd = this._closest(e.target, '[data-ai-model-add]')?.getAttribute('data-ai-model-add');
      if (modelAdd) {
        const input = this._el?.querySelector(`[data-ai-model-input="${modelAdd}"]`);
        const name = input ? input.value : '';
        if (!addModel(modelAdd, name)) {
          eventBus.emit('toast:show', { message: '模型名为空或已存在', type: 'error' });
          return;
        }
        this._render();
        return;
      }

      const modelRemove = this._closest(e.target, '[data-ai-model-remove]')?.getAttribute('data-ai-model-remove');
      if (modelRemove) {
        const [providerId, modelName] = modelRemove.split('|');
        removeModel(providerId, modelName);
        this._render();
        return;
      }

      const modelSelect = this._closest(e.target, '[data-ai-model-select]')?.getAttribute('data-ai-model-select');
      if (modelSelect) {
        const [providerId, modelName] = modelSelect.split('|');
        setActiveSelection(providerId, modelName);
        this._render();
        eventBus.emit('toast:show', { message: `已切换到 ${modelName}`, type: 'success' });
        return;
      }

      const aiAction = this._closest(e.target, '[data-ai-action]')?.getAttribute('data-ai-action');
      if (aiAction === 'test') {
        this._testAiConnection();
        return;
      }
      if (aiAction === 'clear') {
        this._clearAiConfig();
        return;
      }

      // ── 账户区域操作 ──
      const accountAction = this._closest(e.target, '[data-action]')?.getAttribute('data-action');
      if (accountAction === 'login') {
        this._openLoginModal();
        return;
      }
      if (accountAction === 'logout') {
        this._handleLogout();
        return;
      }
      if (accountAction === 'edit-nickname') {
        this._nicknameEditing = true;
        this._render();
        this._el?.querySelector('[data-nickname-input]')?.focus();
        return;
      }
      if (accountAction === 'cancel-nickname') {
        this._nicknameEditing = false;
        this._render();
        return;
      }
      if (accountAction === 'save-nickname') {
        const input = this._el?.querySelector('[data-nickname-input]');
        if (input) {
          this._handleNicknameSave(input.value);
        }
        return;
      }
      if (accountAction === 'upload-avatar') {
        this._el?.querySelector('[data-avatar-input]')?.click();
        return;
      }

      // ── 登录弹窗操作 ──
      const modalAction = this._closest(e.target, '[data-modal-action]')?.getAttribute('data-modal-action');
      if (modalAction === 'close-login') {
        this._closeLoginModal();
        return;
      }
      if (modalAction === 'utools-login') {
        this._handleUToolsLogin();
        return;
      }
      if (modalAction === 'send-magic-link') {
        const emailInput = document.getElementById('login-email-input');
        if (emailInput) {
          this._handleSendMagicLink(emailInput.value);
        }
        return;
      }
      if (modalAction === 'verify-magic-link') {
        const tokenInput = document.getElementById('login-token-input');
        if (tokenInput) {
          this._handleVerifyMagicLink(tokenInput.value);
        }
        return;
      }
    });

    // 头像文件选择
    this._el.addEventListener('change', (e) => {
      const fileInput = e.target.closest('[data-avatar-input]');
      if (fileInput && fileInput.files?.[0]) {
        this._handleAvatarUpload(fileInput.files[0]);
      }
    });

    // AI 配置字段：随输随存（宿主/本机分层由 AI_CONFIG 决定）。
    // 这里刻意不触发 _render()：重渲染会打断输入焦点，用户正在填的字段
    // 会被自己的输入框"吞字"。校验提示在切页或点按钮（测试/清空）时刷新。
    this._el.addEventListener('input', (e) => {
      const target = e.target;
      if (!target?.getAttribute) {
        return;
      }

      // 提供商的基础信息（名称 / 服务地址）
      const providerField = target.getAttribute('data-ai-provider-field');
      if (providerField) {
        const [providerId, key] = providerField.split(':');
        if (key === 'label' || key === 'baseUrl') {
          updateProvider(providerId, { [key]: target.value });
          // 地址是「就绪」的关键字段，边输边更新提示；但绝不整页重渲染
          // ——重渲染会打断输入焦点，用户正在填的字会被吞掉。
          if (key === 'baseUrl') {
            this._refreshAiConfigHints();
          }
        }
        return;
      }

      // 提供商的 API Key（只存本机）
      const providerKey = target.getAttribute('data-ai-provider-key');
      if (providerKey) {
        setProviderKey(providerKey, target.value);
        return;
      }

      const field = target.getAttribute('data-ai-field');
      if (!field) {
        return;
      }
      setAiConfigField(field, target.value);
    });

    this._el.addEventListener('error', (e) => {
      const avatar = e.target.closest?.('.account-page__avatar-img');
      if (!avatar) {
        return;
      }
      const fallback = document.createElement('div');
      fallback.className = avatar.className.replace('account-page__avatar-img', 'account-page__avatar-fallback');
      fallback.textContent = avatar.dataset.initial || 'U';
      avatar.replaceWith(fallback);
    }, true);
  }

  _renderNavItem(section, label) {
    const isActive = this._activeSection === section;
    return `
      <button class="account-page__nav-item ${isActive ? 'account-page__nav-item--active' : ''}" type="button" data-section="${section}">
        ${this._escapeHTML(label)}
      </button>
    `;
  }

  _closest(target, selector) {
    if (!target) {
      return null;
    }
    const match = typeof target.closest === 'function'
      ? target.closest(selector)
      : target.parentElement?.closest?.(selector) || null;

    if (match && typeof this._el?.contains === 'function' && !this._el.contains(match)) {
      return null;
    }
    return match;
  }

  _renderSection() {
    if (this._activeSection === 'settings') {
      return this._renderSettings();
    }
    if (this._activeSection === 'ai') {
      return this._renderAiConfig();
    }
    if (this._activeSection === 'updates') {
      return this._renderUpdates();
    }
    if (this._activeSection === 'about') {
      return this._renderAbout();
    }
    return this._renderMine();
  }

  // ═══════════════════════════════════════
  // 我的区域（登录 / 昵称头像编辑）
  // ═══════════════════════════════════════

  _renderMine() {
    let identityCard = '';
    if (this._profileLoading) {
      identityCard = `
        <div class="account-card account-card--profile">
          <div class="account-page__loading">加载中…</div>
        </div>
      `;
    } else if (!this._identity.isAuthenticated()) {
      identityCard = `
        <div class="account-card account-card--profile">
          <div class="account-card__body">
            <div class="account-card__label">我的账号</div>
            <h2>未登录</h2>
            <p>登录后可以同步昵称和头像，使用素材网盘等更多功能。</p>
            <button class="account-page__btn account-page__btn--primary" type="button" data-action="login">登录 / 注册</button>
          </div>
        </div>
      `;
    } else {
      const profile = this._profile || {};
      const nickname = profile.nickname || '未设置';
      const avatar = profile.avatar;
      const initial = this._getInitial(nickname);
      const uid = profile.id || '—';

      let nicknameRow = '';
      if (this._nicknameEditing) {
        nicknameRow = `
          <div class="account-page__nickname-row">
            <input type="text" class="account-page__nickname-input" id="nickname-input" value="${this._escapeAttr(nickname)}" placeholder="设置昵称" maxlength="32" data-nickname-input>
            <button class="account-page__btn account-page__btn--small" type="button" data-action="save-nickname">保存</button>
            <button class="account-page__btn account-page__btn--small" type="button" data-action="cancel-nickname">取消</button>
          </div>
        `;
      } else {
        nicknameRow = `
          <div class="account-page__nickname-row">
            <span class="account-page__nickname-display">${this._escapeHTML(nickname)}</span>
            <button class="account-page__btn account-page__btn--small" type="button" data-action="edit-nickname">修改</button>
          </div>
        `;
      }

      identityCard = `
        <div class="account-card account-card--profile">
          <div class="account-card__avatar-wrap" data-action="upload-avatar" title="点击更换头像">
            ${avatar
    ? `<img class="account-page__avatar account-page__avatar--large account-page__avatar-img" src="${this._escapeAttr(avatar)}" alt="${this._escapeAttr(nickname)}" data-initial="${this._escapeAttr(initial)}">`
    : `<div class="account-page__avatar account-page__avatar--large account-page__avatar-fallback">${this._escapeHTML(initial)}</div>`
}
            <div class="account-page__avatar-edit-hint"><span>更换</span></div>
          </div>
          <div class="account-card__body">
            <div class="account-card__label">我的账号</div>
            ${nicknameRow}
            <p>UID：${this._escapeHTML(uid)}</p>
            <p class="account-page__hint">昵称和头像将同步到所有已登录的设备。</p>
            <button class="account-page__btn" type="button" data-action="logout">退出登录</button>
          </div>
          <input type="file" id="avatar-file-input" accept="image/png,image/jpeg,image/webp" data-avatar-input hidden>
        </div>
      `;
    }

    return identityCard;
  }

  /**
   * 设置页：分组 + 行式布局。
   *
   * 设置项按「外观 / 画板布局 / 侧栏」三个分组组织，每个分组一张卡片，
   * 组内每个设置项渲染为一行（标题 + 说明在左，分段选择控件在右）。
   * 行清单集中在本方法内声明，控件渲染与点击分发分别由
   * _renderSettingRow / _applySetting 承担。
   * @returns {string}
   */
  _renderSettings() {
    const groups = [
      {
        title: '外观',
        rows: [
          {
            setting: 'theme',
            title: '主题',
            desc: '选择适合当前图片处理环境的界面主题。',
            current: getThemeChoice(),
            options: [
              { label: '跟随系统', value: THEME_CHOICES.SYSTEM },
              { label: '浅色', value: THEME_CHOICES.LIGHT },
              { label: '深色', value: THEME_CHOICES.DARK }
            ]
          }
        ]
      },
      {
        title: '画板布局',
        rows: [
          {
            setting: 'sidePanelLayout',
            title: '属性/图层面板排列',
            desc: 'Tab 切换更节省空间，上下布局可以同时查看两块内容。',
            current: this._getSidePanelLayout(),
            options: [
              { label: 'Tab 切换', value: SIDE_PANEL_LAYOUTS.TABS },
              { label: '上下布局', value: SIDE_PANEL_LAYOUTS.SPLIT }
            ]
          },
          {
            setting: 'editorSidePanelPosition',
            title: '属性/图层面板位置',
            desc: '将属性和图层侧栏放在画板右侧，或移到左侧工具栏与画板之间。',
            current: this._getEditorSidePanelPosition(),
            options: [
              { label: '画板右侧', value: EDITOR_SIDE_PANEL_POSITIONS.RIGHT },
              { label: '工具栏右侧', value: EDITOR_SIDE_PANEL_POSITIONS.LEFT }
            ]
          },
          {
            setting: 'editorBarsLayout',
            title: '预设栏/状态栏位置',
            desc: '切换预设栏和状态栏在编辑器顶部、底部的相对位置。',
            current: this._getEditorBarsLayout(),
            options: [
              { label: '预设栏在顶部', value: EDITOR_BARS_LAYOUTS.PRESETS_TOP },
              { label: '状态栏在顶部', value: EDITOR_BARS_LAYOUTS.STATUS_TOP }
            ]
          }
        ]
      },
      {
        title: '侧栏',
        rows: [
          {
            setting: 'toolbarLabels',
            title: '图标文字',
            desc: '在工具图标下方显示文字标签，关闭后仅显示图标，更节省空间。',
            current: this._getToolbarLabelsVisible(),
            options: [
              { label: '显示文字', value: TOOLBAR_LABELS_VISIBLE.ON },
              { label: '仅图标', value: TOOLBAR_LABELS_VISIBLE.OFF }
            ]
          },
          {
            setting: 'toolbarHistoryLayout',
            title: '撤销/重做按钮',
            desc: '完整为图标加文字的纵向大按钮，紧凑为两个图标按钮并排。',
            current: this._getToolbarHistoryLayout(),
            options: [
              { label: '完整', value: TOOLBAR_HISTORY_LAYOUT.STACKED },
              { label: '紧凑', value: TOOLBAR_HISTORY_LAYOUT.COMPACT }
            ]
          },
          {
            setting: 'toolbarCollapsed',
            title: '展开/收起',
            desc: '展开后侧栏图标和文字并排显示，收起后更节省空间。',
            current: this._getToolbarCollapsed(),
            options: [
              { label: '展开', value: TOOLBAR_COLLAPSED.EXPANDED },
              { label: '收起', value: TOOLBAR_COLLAPSED.COLLAPSED }
            ]
          },
          {
            setting: 'toolbarToggleVisible',
            title: '展开/收起切换按钮',
            desc: '是否在侧栏顶部显示切换按钮，关闭后仍可在设置中切换侧栏状态。',
            current: this._getToolbarToggleVisible(),
            options: [
              { label: '显示', value: TOOLBAR_TOGGLE_VISIBLE.ON },
              { label: '隐藏', value: TOOLBAR_TOGGLE_VISIBLE.OFF }
            ]
          }
        ]
      }
    ];

    return groups.map((group) => `
      <section class="settings-group">
        <div class="settings-group__title">${this._escapeHTML(group.title)}</div>
        ${group.rows.map((row) => this._renderSettingRow(row)).join('')}
      </section>
    `).join('');
  }

  /**
   * 渲染单个设置项行：左侧标题与说明，右侧分段选择控件。
   * @param {{setting: string, title: string, desc: string, current: string, options: {label: string, value: string}[]}} row
   * @returns {string}
   */
  _renderSettingRow(row) {
    const options = row.options.map((opt) => `
      <button class="settings-segment__option ${opt.value === row.current ? 'settings-segment__option--active' : ''}"
              type="button"
              data-setting-choice="${this._escapeAttr(row.setting)}"
              data-value="${this._escapeAttr(opt.value)}"
              aria-pressed="${opt.value === row.current ? 'true' : 'false'}">${this._escapeHTML(opt.label)}</button>
    `).join('');

    return `
      <div class="settings-row">
        <div class="settings-row__info">
          <div class="settings-row__title">${this._escapeHTML(row.title)}</div>
          <div class="settings-row__desc">${this._escapeHTML(row.desc)}</div>
        </div>
        <div class="settings-row__control settings-segment" role="group" aria-label="${this._escapeAttr(row.title)}">${options}</div>
      </div>
    `;
  }

  /**
   * 应用一个设置项变更（设置页统一入口）。
   * 键名与 _renderSettings 中各行的 setting 字段一一对应，
   * 取值合法性由各 setter 自行校验。
   * @param {string} setting - 设置项标识
   * @param {string} value - 新取值
   */
  _applySetting(setting, value) {
    const setters = {
      theme: this._setTheme,
      sidePanelLayout: this._setSidePanelLayout,
      editorSidePanelPosition: this._setEditorSidePanelPosition,
      editorBarsLayout: this._setEditorBarsLayout,
      toolbarLabels: this._setToolbarLabelsVisible,
      toolbarHistoryLayout: this._setToolbarHistoryLayout,
      toolbarCollapsed: this._setToolbarCollapsed,
      toolbarToggleVisible: this._setToolbarToggleVisible
    };

    const setter = setters[setting];
    if (setter) {
      setter.call(this, value);
    }
  }

  /**
   * 服务地址的输入提示（空串表示当前值可用）。
   *
   * 判定走 AI_CONFIG.getAiBaseUrlIssue()，与保存/执行前的校验同一个口径：
   * 空 → 必填；公网明文 → 明确说必须 https；本机/局域网 http → 放行。
   * 只服务于输入框旁的即时提示，真正的就绪判定仍由 getAiConfigStatus() 给出。
   * @param {string} baseUrl
   * @returns {string}
   */
  _describeBaseUrl(baseUrl) {
    const issue = getAiBaseUrlIssue(baseUrl);
    if (issue === AI_CONFIG_STATUS.NO_BASE_URL) {
      return '必填；公网地址用 https://，本机或局域网地址可用 http://（例如 http://192.168.1.10:8326/v1）';
    }
    if (issue === AI_CONFIG_STATUS.INSECURE_BASE_URL) {
      return '公网地址需要以 https:// 开头（本机或局域网地址可用 http://）';
    }
    return '';
  }

  /**
   * 局部刷新 AI 配置页的就绪提示（不重渲染整页，避免打断输入焦点）。
   *
   * 只更新三处：服务地址输入框下的即时提示、状态徽章、状态原因行。
   * 列表里的「缺地址」标记与模型选中态仍依赖下一次重渲染（用户点
   * 「添加模型」、切换提供商或重进页面时自然刷新）。
   * @returns {void}
   */
  _refreshAiConfigHints() {
    if (!this._el) {
      return;
    }

    this._el.querySelectorAll('[data-ai-provider-url-hint]').forEach((hintEl) => {
      const providerId = hintEl.getAttribute('data-ai-provider-url-hint');
      const input = this._el.querySelector(`[data-ai-provider-field="${providerId}:baseUrl"]`);
      hintEl.textContent = this._describeBaseUrl(input ? input.value : '');
    });

    const status = getAiConfigStatus();
    const badge = this._el.querySelector('[data-ai-status-badge]');
    if (badge) {
      badge.classList.toggle('account-page__ai-status--ready', status.ready);
      badge.classList.toggle('account-page__ai-status--unavailable', !status.ready);
      badge.textContent = status.ready ? '云端 AI 已就绪' : '云端 AI 未配置';
    }
    const reasonEl = this._el.querySelector('[data-ai-status-reason]');
    if (reasonEl) {
      reasonEl.textContent = status.ready ? '' : status.message;
    }
  }

  /**
   * AI 配置页（「设置」与「更新记录」之间的独立导航项）。
   *
   * 结构：提供商（地址 + Key）→ 每个提供商下的模型列表。
   * 用户可以一次配置多个提供商、每个提供商多个模型，模型点选即切换
   * 编辑器里使用的那一个。字段与存储分层全部由 ai/AI_CONFIG.js 负责，
   * 本方法只做渲染与派发。
   * @returns {string}
   */
  _renderAiConfig() {
    // 网页版不开放自定义服务商：浏览器直连第三方接口受 CORS 限制，
    // 且不建议让用户在公开网页里粘贴 API Key。这里只给说明，不渲染表单。
    if (this._isWebPlatform()) {
      return `
        <div class="account-card account-card--ai-note">
          <div class="account-card__label">AI</div>
          <div class="account-card__value">网页版不支持自定义 AI 服务商</div>
          <p>出于密钥安全与浏览器跨域限制，网页版不提供第三方服务商接入。AI 编辑功能请在 uTools / ZTools 桌面客户端中使用。</p>
        </div>
      `;
    }

    const providers = listProviders();
    const selection = getActiveSelection();
    const config = getAiConfig();
    // 状态与文案都来自 AI_CONFIG 的唯一判定入口：这里只负责展示，
    // 不再自己用 validateAiConfig().ok 拼一句「未配置」。
    const status = getAiConfigStatus(config);
    const ready = status.ready;
    const systemPrompt = config.systemPrompt || '';
    const systemPromptField = AI_CONFIG_FIELDS.systemPrompt;

    // 左侧当前编辑项：先看用户点过哪个，再回退到正在使用的提供商，最后取第一个
    const editingId = (this._aiProviderId && providers.some((p) => p.id === this._aiProviderId))
      ? this._aiProviderId
      : (selection.providerId || (providers[0] ? providers[0].id : ''));
    const editing = providers.find((p) => p.id === editingId) || null;

    const providerItems = providers.length
      ? providers.map((provider) => {
        const inUse = provider.id === selection.providerId;
        // 完整性一目了然：缺服务地址的提供商不可能被「使用中」，
        // 但过去列表只标「N 个模型 / 缺 Key」，看不出问题出在地址上。
        const meta = [
          `${provider.models.length} 个模型`,
          provider.baseUrl ? '' : '缺地址',
          inUse ? '使用中' : '',
          provider.hasKey ? '' : '缺 Key'
        ].filter(Boolean).join(' · ');
        return `
          <button type="button" class="ai-provider-item${provider.id === editingId ? ' ai-provider-item--editing' : ''}${inUse ? ' ai-provider-item--in-use' : ''}${provider.baseUrl ? '' : ' ai-provider-item--incomplete'}"
                  data-ai-provider-open="${provider.id}">
            <span class="ai-provider-item__name">${this._escapeHTML(provider.label || '未命名服务商')}</span>
            <span class="ai-provider-item__meta">${this._escapeHTML(meta)}</span>
          </button>
        `;
      }).join('')
      : '<div class="ai-provider-empty">还没有提供商，从下面添加一个</div>';

    const modelChips = editing && editing.models.length
      ? editing.models.map((model) => {
        const active = editing.id === selection.providerId && model === selection.model;
        return `
          <span class="ai-model-chip${active ? ' ai-model-chip--active' : ''}">
            <button type="button" class="ai-model-chip__pick"
                    data-ai-model-select="${editing.id}|${this._escapeAttr(model)}">${this._escapeHTML(model)}</button>
            <button type="button" class="ai-model-chip__remove"
                    data-ai-model-remove="${editing.id}|${this._escapeAttr(model)}" title="删除该模型">×</button>
          </span>
        `;
      }).join('')
      : '<span class="ai-config-hint">还没有模型，在下面输入模型名添加</span>';

    const detail = editing
      ? `
        <div class="ai-config-detail">
          <div class="ai-config-detail__head">
            <input class="account-page__ai-input ai-config-detail__name" type="text"
                   value="${this._escapeAttr(editing.label)}" data-ai-provider-field="${editing.id}:label"
                   maxlength="77" autocomplete="off" placeholder="提供商名称">
            <button class="account-page__btn" type="button" data-ai-provider-remove="${editing.id}">删除提供商</button>
          </div>

          <label class="ai-config-field">
            <span class="ai-config-field__label">服务地址</span>
            <input class="account-page__ai-input" type="text" value="${this._escapeAttr(editing.baseUrl)}"
                   data-ai-provider-field="${editing.id}:baseUrl" maxlength="277"
                   autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1">
            <span class="ai-config-field__hint ai-config-field__hint--warn"
                  data-ai-provider-url-hint="${editing.id}">${this._escapeHTML(this._describeBaseUrl(editing.baseUrl))}</span>
          </label>

          <label class="ai-config-field">
            <span class="ai-config-field__label">API Key${editing.hasKey ? `（${this._escapeHTML(maskApiKey(editing.key))}）` : ''}</span>
            <input class="account-page__ai-input" type="password" value="${this._escapeAttr(editing.key)}"
                   data-ai-provider-key="${editing.id}" maxlength="277"
                   autocomplete="off" spellcheck="false" placeholder="sk-…">
            <span class="ai-config-field__hint">只保存在本机，不随账号同步</span>
          </label>

          <div class="ai-config-models">
            <div class="ai-config-models__head">
              <span class="ai-config-field__label">模型</span>
              <span class="ai-config-hint">点选即切换，× 删除</span>
            </div>
            <div class="ai-model-row">${modelChips}</div>
            <div class="ai-config-add-model">
              <input class="account-page__ai-input" type="text" data-ai-model-input="${editing.id}"
                     maxlength="77" autocomplete="off" spellcheck="false" placeholder="模型名，如 gpt-4o-mini">
              <button class="account-page__btn" type="button" data-ai-model-add="${editing.id}">添加模型</button>
            </div>
          </div>
        </div>
      `
      : '<div class="ai-config-detail ai-config-detail--empty">在左侧选择或添加一个提供商</div>';

    return `
      <div class="account-card account-card--ai-status">
        <div class="account-card__label">AI</div>
        <div class="account-card__value">配置状态</div>
        <p>配置完成后，在编辑器左侧选「AI 修图」工具，于右侧栏直接写提示词即可让 AI 编辑当前图片。</p>
        <div class="account-page__theme-row">
          <span class="account-page__ai-status ${ready ? 'account-page__ai-status--ready' : 'account-page__ai-status--unavailable'}"
                data-ai-status-badge>
            ${ready ? '云端 AI 已就绪' : '云端 AI 未配置'}
          </span>
          ${ready ? `<span class="account-page__ai-key-hint">当前：${this._escapeHTML(config.model)}</span>` : ''}
        </div>
        ${ready ? '' : `<p class="ai-config-status-reason" data-ai-status-reason>${this._escapeHTML(status.message)}</p>`}
        <div class="account-page__theme-row">
          <button class="account-page__btn account-page__btn--primary" type="button" data-ai-action="test">测试连接</button>
          <button class="account-page__btn" type="button" data-ai-action="clear">清空配置</button>
          <span class="account-page__ai-test-result" data-ai-test-result></span>
        </div>
      </div>

      <div class="ai-config-split">
        <div class="ai-config-side">
          <div class="ai-config-side__head">提供商</div>
          <div class="ai-config-list">${providerItems}</div>
          <div class="ai-config-side__add">
            <div class="ai-config-add-presets">
              ${AI_SERVICE_PRESETS.filter((preset) => preset.id !== 'custom').map((preset) => `
                <button class="ai-config-preset" type="button" data-ai-provider-add="${preset.id}">${this._escapeHTML(preset.label)}</button>
              `).join('')}
            </div>
            <input class="account-page__ai-input" type="text" data-ai-new-provider-label
                   maxlength="77" autocomplete="off" placeholder="名称，如 自建网关">
            <input class="account-page__ai-input" type="text" data-ai-new-provider-url
                   maxlength="277" autocomplete="off" spellcheck="false" placeholder="地址，如 https://api.example.com/v1">
            <button class="account-page__btn" type="button" data-ai-provider-add-custom>添加自定义提供商</button>
          </div>
        </div>

        ${detail}
      </div>

      <div class="account-card">
        <div class="account-card__label">AI</div>
        <div class="account-card__value">${this._escapeHTML(systemPromptField.label)}</div>
        <p>${this._escapeHTML(systemPromptField.description)}</p>
        <textarea class="account-page__ai-input account-page__ai-input--area" rows="7"
                  data-ai-field="systemPrompt" maxlength="${systemPromptField.maxlength}"
                  placeholder="${this._escapeAttr(systemPromptField.placeholder)}">${this._escapeHTML(systemPrompt)}</textarea>
      </div>

      <div class="account-card account-card--ai-note">
        <div class="account-card__label">隐私</div>
        <div class="account-card__value">数据去向</div>
        <p>云端 AI 只会把你填写的服务地址收到的一张 ≤777px 压缩预览图与提示词发给该服务商；原图不会上传，API Key 只保存在本机、只发往你填写的地址。</p>
      </div>
    `;
  }

  /**
   * 清空 AI 配置：删除全部提供商、本机 Key 与系统提示词。
   * 保留提示词草稿（不是凭据，清掉会让用户误删刚写的内容）。
   */
  _clearAiConfig() {
    listProviders().forEach((provider) => {
      removeProvider(provider.id);
    });
    setAiConfigField('systemPrompt', '');
    this._render();
    eventBus.emit('toast:show', { message: 'AI 配置已清空（含本机保存的 API Key）', type: 'success' });
  }

  /**
   * 测试 AI 服务商连通性（实现在 OpenAiCompatProvider，网络出口走 AIPort）。
   * 结果不含 Key，只展示服务商状态与模型列表摘要。
   */
  async _testAiConnection() {
    const resultEl = this._el?.querySelector('[data-ai-test-result]');
    if (resultEl) {
      resultEl.textContent = '正在测试…';
    }
    const result = await testAiConnection();
    if (resultEl) {
      resultEl.textContent = '';
    }
    if (result.ok) {
      this._render();
    }
    eventBus.emit('toast:show', {
      // message 各分支已自含语义（连接成功 / 请先完善 AI 配置：… / 服务商返回 …），
      // 不再叠一层「连接失败：」前缀，避免出现「连接失败：请先填写服务地址」这种别扭拼接。
      message: result.message,
      type: result.ok ? 'success' : 'error'
    });
  }

  _renderAbout() {
    const appVersion = this._getCurrentVersion();
    const hostName = this._getHostName();
    const hostVersion = this._getHostVersion();
    const qqUrl = this._getContactUrl();

    return `
      <div class="account-about">
        <section class="account-about__hero">
          <div class="account-about__hero-glow"></div>
          <div class="account-about__logo-wrap">
            <img class="account-about__logo" src="../logo.png" alt="图片工具箱" draggable="false">
          </div>
          <div class="account-about__hero-body">
            <div class="account-about__kicker">Image Toolbox for ${this._escapeHTML(hostName)}</div>
            <h2>图片工具箱</h2>
            <p>一款专注截图和图片快速处理的 ${this._escapeHTML(hostName)} 插件，提供马赛克、裁剪、加字和快速导出能力。</p>
            <div class="account-about__tags" aria-label="功能标签">
              <span>轻量编辑</span>
              <span>本地处理</span>
              <span>快速导出</span>
            </div>
          </div>
        </section>

        <div class="account-about__layout">
          <section class="account-about__panel account-about__author">
            <div class="account-about__section-label">作者</div>
            <div class="account-about__author-name">抹露茶柒</div>
            <p>感谢使用图片工具箱。如果你有功能建议、问题反馈或协作想法，可以通过下面的方式联系。</p>
          </section>

          <section class="account-about__panel account-about__contacts" aria-label="联系方式">
            <a class="account-about__contact" href="https://moruteaven.com" data-external-url="https://moruteaven.com">
              <span class="account-about__contact-icon">W</span>
              <span>
                <strong>作者主页</strong>
                <em>moruteaven.com</em>
              </span>
            </a>
            <a class="account-about__contact" href="mailto:me@moruteaven.com" data-external-url="mailto:me@moruteaven.com">
              <span class="account-about__contact-icon">@</span>
              <span>
                <strong>联系邮箱</strong>
                <em>me@moruteaven.com</em>
              </span>
            </a>
            <a class="account-about__contact" href="${this._escapeAttr(qqUrl)}" data-external-url="${this._escapeAttr(qqUrl)}">
              <span class="account-about__contact-icon">Q</span>
              <span>
                <strong>QQ 交流群</strong>
                <em>加入群聊反馈问题</em>
              </span>
            </a>
          </section>
        </div>

        <section class="account-about__footer">
          <span>图片工具箱版本：${this._escapeHTML(appVersion)}</span>
          <span>${this._escapeHTML(hostName)} 版本：${this._escapeHTML(hostVersion)}</span>
          <span>Copyright © 抹露茶柒</span>
        </section>
      </div>
    `;
  }

  _renderUpdates() {
    return `
      <div class="updates-list">
        ${CHANGELOG.map(record => this._renderUpdateRecord(record)).join('')}
      </div>
    `;
  }

  _renderUpdateRecord(record) {
    return `
      <article class="update-record">
        <div class="update-record__header">
          <h2>版本 ${this._escapeHTML(record.version)}</h2>
          <time>${this._escapeHTML(record.date)}</time>
        </div>
        <div class="update-record__changes">
          ${updateCategories.map(category => this._renderChangeGroup(record, category)).join('')}
        </div>
      </article>
    `;
  }

  _renderChangeGroup(record, category) {
    const items = record.changes?.[category.key] || [];
    if (items.length === 0) {
      return '';
    }

    // 过滤出当前平台应显示的项目
    const visibleItems = items.filter(item => {
      // 兼容旧格式（字符串）
      if (typeof item === 'string') {
        return true;
      }
      // 新格式（对象）- 检查平台限制
      return shouldShowForCurrentPlatform(item.platforms, this._getCurrentPlatform());
    });

    if (visibleItems.length === 0) {
      return '';
    }

    return `
       <div class="update-record__group update-record__group--${category.key}">
         <div class="update-record__group-title">${this._escapeHTML(category.title)}</div>
         <ul>
           ${visibleItems.map(item => this._renderChangeItem(item)).join('')}
         </ul>
       </div>
     `;
  }

  /**
    * 渲染单个更新项（仅展示文本内容，不展示平台标签）
    */
  _renderChangeItem(item) {
    // 兼容旧格式（字符串）
    if (typeof item === 'string') {
      return `<li>${this._escapeHTML(item)}</li>`;
    }

    // 新格式（对象）— 仅展示文本，平台过滤已在 _renderChangeGroup 中完成
    const text = item.text || '';
    return `<li>${this._escapeHTML(text)}</li>`;
  }

  /**
   * 复制更新日志到剪贴板。
   * 直接用纯文本拼接，避免依赖 DOM 选区（应用全局 user-select: none）。
   */
  async _copyUpdates() {
    const text = this._getUpdatesPlainText();
    if (!text) {
      eventBus.emit('toast:show', { message: '没有可复制的更新日志', type: 'error' });
      return;
    }

    const ok = await this._writeClipboardText(text);
    eventBus.emit('toast:show', {
      message: ok ? '更新日志已复制' : '复制失败，请手动选择文本复制',
      type: ok ? 'success' : 'error'
    });
  }

  /**
   * 将可见的更新日志拼装为纯文本。
   * @returns {string}
   */
  _getUpdatesPlainText() {
    return CHANGELOG.map((record) => {
      const lines = [`版本 ${record.version}（${record.date}）`];

      updateCategories.forEach((category) => {
        const items = record.changes?.[category.key] || [];
        const visibleItems = items
          .map((item) => (typeof item === 'string' ? item : item?.text || ''))
          .filter((item) => {
            if (typeof item === 'string') {
              return true;
            }
            return shouldShowForCurrentPlatform(item.platforms, this._getCurrentPlatform());
          })
          .map((item) => String(item).trim())
          .filter(Boolean);

        if (visibleItems.length === 0) {
          return;
        }

        lines.push(`【${category.title}】`);
        visibleItems.forEach((item) => lines.push(`- ${item}`));
      });

      return lines.join('\n');
    }).join('\n\n');
  }

  /**
   * 写入文本到剪贴板：优先走宿主适配器，降级到 navigator.clipboard 与 execCommand。
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async _writeClipboardText(text) {
    try {
      const ok = await this._host?.clipboard?.writeText?.(text);
      if (ok) {
        return true;
      }
    } catch (e) {
      console.warn('[AccountPage] 宿主剪贴板写入失败:', e);
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn('[AccountPage] navigator.clipboard 写入失败:', e);
    }

    return this._writeClipboardTextFallback(text);
  }

  /**
   * 降级方案：临时 textarea + execCommand（无剪贴板权限时可用）。
   * @param {string} text
   * @returns {boolean}
   */
  _writeClipboardTextFallback(text) {
    if (typeof document === 'undefined') {
      return false;
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand?.('copy') ?? false;
      document.body.removeChild(textarea);
      return ok;
    } catch (e) {
      console.warn('[AccountPage] execCommand 复制失败:', e);
      return false;
    }
  }

  _renderAvatar(className) {
    const user = this._getUserView();
    const title = this._escapeAttr(user.name);
    const initial = this._escapeAttr(user.initial);

    if (user.avatar) {
      return `<img class="${className} account-page__avatar-img" src="${this._escapeAttr(user.avatar)}" alt="${title}" data-initial="${initial}" draggable="false">`;
    }

    return `<div class="${className} account-page__avatar-fallback">${this._escapeHTML(user.initial)}</div>`;
  }

  _getUserView() {
    const user = this._user || {};
    const hostName = this._getHostName();
    const name = user.nickname || user.name || user.userName || user.username || `${hostName} 用户`;
    const avatar = user.avatar || user.avatarUrl || user.photo || '';
    return {
      name,
      avatar,
      initial: this._getInitial(name),
      status: this._user ? `已连接 ${hostName} 用户信息` : `未获取到 ${hostName} 用户信息`
    };
  }

  _getSectionTitle(section) {
    const titles = {
      mine: '我的',
      settings: '设置',
      ai: 'AI 配置',
      updates: '更新记录',
      about: '关于'
    };
    return titles[section] || titles.mine;
  }

  _setTheme(theme) {
    applyThemeChoice(theme);
  }

  /**
   * 插件自身版本号。
   *
   * 单一事实来源是 HostAdapter.platform.appVersion（由各端适配器从 preload
   * 透传的宿主插件版本读取，最终来自 plugin.json）。历史上这里取的是更新记录
   * 的第一条（updateRecords[0].version），在更新记录与发布版本脱节时会显示
   * 一个早已作废的版本号（如市场已发 2.3.2、插件内却显示 1.2.3）。
   *
   * 取不到宿主版本时才回退到 core 的 APP_VERSION，绝不再用更新记录冒充版本号。
   * @returns {string}
   */
  _getCurrentVersion() {
    const hostVersion = this._getHostPluginVersion();
    if (hostVersion) {
      return this._formatVersion(hostVersion);
    }

    console.warn('[AccountPage] 未能从宿主读取插件版本，回退到 APP_VERSION');
    return this._formatVersion(getAppVersion());
  }

  /**
   * 从宿主适配器读取本插件版本（非宿主程序自身版本）。
   * @returns {string} 版本号，取不到时返回空字符串
   */
  _getHostPluginVersion() {
    try {
      const version = this._host?.platform?.appVersion;
      if (version && String(version).trim()) {
        return String(version).trim();
      }
    } catch (e) {
      console.warn('[AccountPage] 获取插件版本失败:', e);
    }

    return '';
  }

  _getHostVersion() {
    try {
      return this._formatVersion(this._host?.platform?.version || this._host?.getHostAppVersion?.());
    } catch (e) {
      console.warn('[AccountPage] 获取宿主版本失败:', e);
    }

    return '未知';
  }

  _formatVersion(version) {
    const text = String(version || '').trim();
    if (!text) {
      return '未知';
    }
    return /^v/i.test(text) ? text : `v${text}`;
  }

  _openExternalUrl(url) {
    if (!url) {
      return;
    }

    try {
      if (this._host?.system?.openExternal?.(url) || this._host?.openHostExternal?.(url)) {
        return;
      }
    } catch (e) {
      console.warn('[AccountPage] 使用宿主打开外部链接失败:', e);
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  _setSidePanelLayout(layout) {
    if (!Object.values(SIDE_PANEL_LAYOUTS).includes(layout)) {
      return;
    }

    localStorage.setItem(SIDE_PANEL_LAYOUT_KEY, layout);
    this._sidePanelTabs?.applyLayout(layout, false);
    eventBus.emit('sidePanel:layoutChanged', layout);
  }

  _setEditorBarsLayout(layout) {
    if (!VALID_EDITOR_BARS_LAYOUTS.has(layout)) {
      return;
    }

    localStorage.setItem(EDITOR_BARS_LAYOUT_KEY, layout);
    eventBus.emit('editorBars:layoutChanged', layout);
  }

  _setEditorSidePanelPosition(position) {
    if (!VALID_EDITOR_SIDE_PANEL_POSITIONS.has(position)) {
      return;
    }

    localStorage.setItem(EDITOR_SIDE_PANEL_POSITION_KEY, position);
    eventBus.emit('editorSidePanel:positionChanged', position);
  }

  _setToolbarLabelsVisible(value) {
    if (!VALID_TOOLBAR_LABELS_VISIBLE.has(value)) {
      return;
    }

    localStorage.setItem(TOOLBAR_LABELS_VISIBLE_KEY, value);
    eventBus.emit('toolbar:labelsVisibilityChanged', value);
  }

  _setToolbarCollapsed(value) {
    if (!VALID_TOOLBAR_COLLAPSED.has(value)) {
      return;
    }

    localStorage.setItem(TOOLBAR_COLLAPSED_KEY, value);
    eventBus.emit('toolbar:collapsedChanged', value);
  }

  _setToolbarToggleVisible(value) {
    if (!VALID_TOOLBAR_TOGGLE_VISIBLE.has(value)) {
      return;
    }

    localStorage.setItem(TOOLBAR_TOGGLE_VISIBLE_KEY, value);
    eventBus.emit('toolbar:toggleVisibleChanged', value);
  }

  _setToolbarHistoryLayout(value) {
    if (!VALID_TOOLBAR_HISTORY_LAYOUT.has(value)) {
      return;
    }

    localStorage.setItem(TOOLBAR_HISTORY_LAYOUT_KEY, value);
    eventBus.emit('toolbar:historyLayoutChanged', value);
  }

  _getSidePanelLayout() {
    const saved = localStorage.getItem(SIDE_PANEL_LAYOUT_KEY);
    return Object.values(SIDE_PANEL_LAYOUTS).includes(saved) ? saved : SIDE_PANEL_LAYOUTS.TABS;
  }

  _getEditorBarsLayout() {
    const saved = localStorage.getItem(EDITOR_BARS_LAYOUT_KEY);
    return VALID_EDITOR_BARS_LAYOUTS.has(saved) ? saved : EDITOR_BARS_LAYOUTS.PRESETS_TOP;
  }

  _getEditorSidePanelPosition() {
    const saved = localStorage.getItem(EDITOR_SIDE_PANEL_POSITION_KEY);
    return VALID_EDITOR_SIDE_PANEL_POSITIONS.has(saved) ? saved : EDITOR_SIDE_PANEL_POSITIONS.RIGHT;
  }

  _getToolbarLabelsVisible() {
    const saved = localStorage.getItem(TOOLBAR_LABELS_VISIBLE_KEY);
    return VALID_TOOLBAR_LABELS_VISIBLE.has(saved) ? saved : TOOLBAR_LABELS_VISIBLE.ON;
  }

  _getToolbarCollapsed() {
    const saved = localStorage.getItem(TOOLBAR_COLLAPSED_KEY);
    return VALID_TOOLBAR_COLLAPSED.has(saved) ? saved : TOOLBAR_COLLAPSED.COLLAPSED;
  }

  _getToolbarToggleVisible() {
    const saved = localStorage.getItem(TOOLBAR_TOGGLE_VISIBLE_KEY);
    return VALID_TOOLBAR_TOGGLE_VISIBLE.has(saved) ? saved : TOOLBAR_TOGGLE_VISIBLE.ON;
  }

  _getToolbarHistoryLayout() {
    const saved = localStorage.getItem(TOOLBAR_HISTORY_LAYOUT_KEY);
    return VALID_TOOLBAR_HISTORY_LAYOUT.has(saved) ? saved : TOOLBAR_HISTORY_LAYOUT.STACKED;
  }

  _getHostUser() {
    try {
      const result = this._host?.user?.getCurrentUser?.() || this._host?.getHostUser?.() || null;
      if (result && typeof result.then === 'function') {
        result.then((user) => {
          this._user = user;
          this._render();
        }).catch((e) => console.warn('[AccountPage] 获取宿主用户信息失败:', e));
        return null;
      }
      return result;
    } catch (e) {
      console.warn('[AccountPage] 获取宿主用户信息失败:', e);
    }
    return null;
  }

  /**
   * 当前平台标识。
   *
   * 单一事实来源是注入的 HostAdapter.platform.id（'utools' / 'ztools' / 'web'），
   * 不再嗅探 window.utools —— ZTools 环境下该全局值可能是 uTools API 的别名。
   * @returns {string|null}
   */
  _getCurrentPlatform() {
    try {
      const id = this._host?.platform?.id;
      if (id) {
        return String(id);
      }
      const name = this._host?.platform?.name || this._host?.getHostName?.();
      if (name) {
        return String(name);
      }
    } catch (e) {
      console.warn('[AccountPage] 获取平台标识失败:', e);
    }
    return inferPlatformFromGlobals();
  }

  /**
   * 是否运行在网页版（决定 AI 配置页是否开放自定义服务商）。
   * @returns {boolean}
   */
  _isWebPlatform() {
    const tokens = toPlatformTokens(this._getCurrentPlatform());
    // PLATFORMS 常量表里没有 web（它只服务更新记录的平台过滤），
    // 这里用 WebHostAdapter.platform.id 的实际取值。
    return tokens.includes('web');
  }

  /**
   * 是否运行在 uTools 宿主中（决定是否展示 uTools 一键登录入口）。
   * @returns {boolean}
   */
  _isUToolsPlatform() {
    const tokens = toPlatformTokens(this._getCurrentPlatform());
    return tokens.includes(PLATFORMS.UTOOLS) && !tokens.includes(PLATFORMS.ZTOOLS);
  }

  /**
   * 宿主能力对象，用于调用宿主专有能力（如 uTools 一键登录）。
   *
   * 注意：这里返回的是 preload 暴露的窄接口集合，而不是宿主原始对象。
   * uTools / ZTools 当前强制关闭 contextIsolation，window.__imageToolboxApi
   * 实际为 null，因此命中下面的直接赋值分支；两者都要保留，
   * 以便宿主将来开启隔离时无需改动本方法。
   * 目前只用到 fetchUserServerTemporaryToken 一项能力。
   * @returns {object|null}
   */
  _getHostApi() {
    if (typeof window === 'undefined') {
      return null;
    }

    const bridged = window.__imageToolboxApi || null;
    if (bridged && typeof bridged.fetchUserServerTemporaryToken === 'function') {
      return bridged;
    }

    // 未启用 contextIsolation 的老宿主：preload 把接口挂在页面 window 上
    if (typeof window.fetchUserServerTemporaryToken === 'function') {
      return { fetchUserServerTemporaryToken: window.fetchUserServerTemporaryToken };
    }

    return null;
  }

  _getHostName() {
    return this._host?.platform?.name || this._host?.getHostName?.() || 'uTools';
  }

  _getContactUrl() {
    try {
      const url = this._host?.getContactUrl?.();
      if (url) {
        return url;
      }
    } catch (e) {
      console.warn('[AccountPage] 获取联系方式失败:', e);
    }
    return 'https://qm.qq.com/q/Nzn12S22e6';
  }

  _getInitial(name) {
    const text = String(name || '').trim();
    return text ? text.slice(0, 1).toUpperCase() : 'U';
  }

  _formatTime(ts) {
    if (!ts) {
      return '—';
    }
    const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    if (isNaN(d.getTime())) {
      return '—';
    }
    return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ═══════════════════════════════════════
  // 账户异步操作
  // ═══════════════════════════════════════

  async _loadProfile() {
    this._profileLoading = true;
    this._render();
    try {
      this._profile = await this._identity.getProfile();
    } catch (e) {
      console.warn('[AccountPage] 加载用户档案失败:', e);
      this._profile = null;
    }
    this._profileLoading = false;
    this._render();
    // 通知侧栏等外部组件同步刷新头像
    eventBus.emit('account:profileChanged', this._profile);
  }

  async _handleNicknameSave(nickname) {
    const trimmed = String(nickname || '').trim();
    if (!trimmed) {
      eventBus.emit('toast:show', { message: '昵称不能为空', type: 'error' });
      return;
    }
    if (trimmed.length > 32) {
      eventBus.emit('toast:show', { message: '昵称最多 32 字符', type: 'error' });
      return;
    }
    try {
      this._profile = await this._identity.updateProfile({ nickname: trimmed });
      this._nicknameEditing = false;
      this._render();
      eventBus.emit('toast:show', { message: '昵称已更新', type: 'success' });
      eventBus.emit('account:profileChanged', this._profile);
    } catch (e) {
      eventBus.emit('toast:show', { message: e?.message || '保存失败', type: 'error' });
    }
  }

  async _handleAvatarUpload(file) {
    try {
      this._profile = await this._identity.uploadAvatar(file);
      this._render();
      eventBus.emit('toast:show', { message: '头像已更新', type: 'success' });
      eventBus.emit('account:profileChanged', this._profile);
    } catch (e) {
      eventBus.emit('toast:show', { message: e?.message || '头像上传失败', type: 'error' });
    }
  }

  async _handleLogout() {
    try {
      await this._identity.logout();
    } catch {}
    this._profile = null;
    this._nicknameEditing = false;
    this._render();
    eventBus.emit('toast:show', { message: '已退出登录', type: 'success' });
    eventBus.emit('account:profileChanged', null);
  }

  // ═══════════════════════════════════════
  // 登录弹窗
  // ═══════════════════════════════════════

  _openLoginModal() {
    let modal = document.getElementById('login-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'login-modal';
      modal.className = 'login-modal';
      document.body.appendChild(modal);
    }
    const isUTools = this._isUToolsPlatform();
    const magicLinkSent = this._magicLinkSending === 'done';
    modal.innerHTML = `
      <div class="login-modal__backdrop" data-modal-action="close-login"></div>
      <div class="login-modal__card">
        <div class="login-modal__header">
          <h3>登录 / 注册</h3>
          <button class="login-modal__close" type="button" data-modal-action="close-login">×</button>
        </div>
        <div class="login-modal__body">
          ${isUTools ? `
            <button class="login-modal__btn login-modal__btn--utools" type="button" data-modal-action="utools-login">
              <span>使用 uTools 账号一键登录</span>
            </button>
            <div class="login-modal__divider"><span>或</span></div>
          ` : ''}
          <div class="login-modal__field">
            <label>邮箱</label>
            <input type="email" id="login-email-input" placeholder="请输入邮箱地址" autocomplete="email" value="${this._escapeAttr(this._magicLinkEmail)}">
          </div>
          ${magicLinkSent ? `
            <p class="login-modal__hint" style="text-align:center;color:var(--accent-color,#597EF7);">
              登录链接已发送到您的邮箱，请查收邮件并点击链接完成登录。
            </p>
            <div class="login-modal__field">
              <label>或手动输入链接中的 token</label>
              <input type="text" id="login-token-input" placeholder="粘贴 Magic Link 中的 token" autocomplete="off">
            </div>
            <button class="login-modal__btn login-modal__btn--primary" type="button" data-modal-action="verify-magic-link">验证并登录</button>
          ` : `
            <button class="login-modal__btn login-modal__btn--primary" type="button" data-modal-action="send-magic-link" id="send-magic-link-btn">
              ${this._magicLinkSending ? '发送中…' : '发送登录链接'}
            </button>
          `}
          <p class="login-modal__hint">首次登录将自动注册账号</p>
        </div>
      </div>
    `;
    modal.classList.add('login-modal--active');

    // 弹窗挂载在 document.body 上，不在 this._el 内，
    // 因此需要单独绑定点击事件
    modal.onclick = (e) => {
      const modalAction = e.target.closest('[data-modal-action]')?.getAttribute('data-modal-action');
      if (modalAction === 'close-login') {
        this._closeLoginModal();
        return;
      }
      if (modalAction === 'utools-login') {
        this._handleUToolsLogin();
        return;
      }
      if (modalAction === 'send-magic-link') {
        const emailInput = document.getElementById('login-email-input');
        if (emailInput) {
          this._handleSendMagicLink(emailInput.value);
        }
        return;
      }
      if (modalAction === 'verify-magic-link') {
        const tokenInput = document.getElementById('login-token-input');
        if (tokenInput) {
          this._handleVerifyMagicLink(tokenInput.value);
        }
        return;
      }
    };
  }

  _closeLoginModal() {
    const modal = document.getElementById('login-modal');
    if (modal) {
      modal.classList.remove('login-modal--active');
      setTimeout(() => modal.remove(), 200);
    }
  }

  async _handleSendMagicLink(email) {
    const btn = document.getElementById('send-magic-link-btn');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      eventBus.emit('toast:show', { message: '请输入有效的邮箱地址', type: 'error' });
      return;
    }
    try {
      if (btn) {
        btn.disabled = true; btn.textContent = '发送中…'; 
      }
      this._magicLinkSending = true;
      this._magicLinkEmail = email;
      await this._identity.requestMagicLink(email);
      this._magicLinkSending = 'done';
      eventBus.emit('toast:show', { message: '登录链接已发送，请查收邮件', type: 'success' });
      this._openLoginModal(); // 重新渲染弹窗，显示 token 输入框
    } catch (e) {
      eventBus.emit('toast:show', { message: e?.message || '发送失败', type: 'error' });
      this._magicLinkSending = false;
      if (btn) {
        btn.disabled = false; btn.textContent = '发送登录链接'; 
      }
    }
  }

  async _handleVerifyMagicLink(token) {
    if (!token || !token.trim()) {
      eventBus.emit('toast:show', { message: '请输入登录链接中的 token', type: 'error' });
      return;
    }
    try {
      await this._identity.verifyMagicLink(token.trim());
      this._closeLoginModal();
      this._magicLinkSending = false;
      this._magicLinkEmail = '';
      eventBus.emit('toast:show', { message: '登录成功', type: 'success' });
      await this._loadProfile();
    } catch (e) {
      eventBus.emit('toast:show', { message: e?.message || '登录失败', type: 'error' });
    }
  }

  async _handleUToolsLogin() {
    try {
      const api = this._getHostApi();
      if (!api?.fetchUserServerTemporaryToken) {
        eventBus.emit('toast:show', { message: '当前环境不支持一键登录', type: 'error' });
        return;
      }
      const { token: accessToken } = await api.fetchUserServerTemporaryToken();
      // 新版 SDK 不再需要 deviceId
      await this._identity.loginWithUTools(accessToken);
      this._closeLoginModal();
      eventBus.emit('toast:show', { message: '登录成功', type: 'success' });
      await this._loadProfile();
    } catch (e) {
      eventBus.emit('toast:show', { message: e?.message || '登录失败', type: 'error' });
    }
  }

  _escapeAttr(value) {
    return escapeAttr(value);
  }

  _escapeHTML(value) {
    return escapeHTML(value);
  }

  destroy() {
    this._eventBusUnsubscribers.forEach(unsub => unsub());
    this._eventBusUnsubscribers = [];
  }
}

export default AccountPage;
