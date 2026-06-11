import eventBus from '../core/EventBus.js';
import { SIDE_PANEL_LAYOUT_KEY, SIDE_PANEL_LAYOUTS } from './SidePanelTabs.js';

const THEME_STORAGE_KEY = 'image-toolbox-theme';
const THEME_VERSION_KEY = 'image-toolbox-theme-version';
const THEME_VERSION = 'neutral-teal-light-default-v1';

const updateRecords = [
  {
    version: '0.3.0',
    date: '2026-06-10',
    changes: {
      added: ['新增账户中心页面，支持从左下角 uTools 头像进入', '新增更新记录页面，用于展示版本功能变更'],
      fixed: [],
      improved: ['优化左侧工具栏结构，工具列表可滚动，账号入口固定在底部'],
      adjusted: ['将用户入口确定为左下角头像，右上角继续留给页面级操作'],
      removed: []
    }
  },
  {
    version: '0.2.4',
    date: '2026-06-10',
    changes: {
      added: [],
      fixed: ['修复 uTools 环境不能加载网络资源导致 Fabric.js 加载失败的问题'],
      improved: ['将 Fabric.js 改为本地资源引用，提升插件加载稳定性'],
      adjusted: [],
      removed: ['移除外部 CDN 脚本引用']
    }
  },
  {
    version: '0.2.3',
    date: '2026-06-09',
    changes: {
      added: ['新增导出成功和失败的应用内 Toast 提示'],
      fixed: ['修复通过文件匹配进入插件后图片不显示的问题', '修复裁切操作无法撤销的问题', '修复文字模式下属性面板不生效的问题', '修复不透明度调整后文字直接消失的问题'],
      improved: ['优化导出后的反馈方式，不再依赖系统通知', '优化不透明度滑块宽度，减少属性面板拥挤感'],
      adjusted: [],
      removed: []
    }
  },
  {
    version: '0.2.0',
    date: '2026-06-08',
    changes: {
      added: ['新增背景图层展示和锁定逻辑', '新增工具栏撤销和重做按钮', '新增 Ctrl+Y 重做快捷键'],
      fixed: ['修复图层面板刷新死循环问题', '修复选择图片后画布无显示的问题', '修复主题切换按钮不生效的问题', '修复工具模式下误触发图层选中和拖动的问题', '修复放大后裁剪框消失的问题'],
      improved: ['优化保存到电脑和复制到剪贴板按钮样式', '优化图层面板排序，顶层图层显示在上方'],
      adjusted: ['将 PNG、JPEG、WebP 导出按钮合并为一个保存到电脑按钮', '将框选打码和画笔打码合并为一个打码工具'],
      removed: ['移除工具栏中重复的导出按钮', '移除独立的画笔打码入口']
    }
  },
  {
    version: '0.1.0',
    date: '2026-06-08',
    changes: {
      added: ['发布第一个可用版本，支持图片导入、打码、裁切、文字标注和导出', '搭建五区编辑器布局：工具栏、选项栏、画布区、属性/图层面板和状态栏'],
      fixed: [],
      improved: [],
      adjusted: [],
      removed: []
    }
  }
];

const updateCategories = [
  { key: 'added', title: '新增' },
  { key: 'adjusted', title: '调整' },
  { key: 'fixed', title: '修复' },
  { key: 'improved', title: '优化' },
  { key: 'removed', title: '去除' }
];

/**
 * 账号页 UI 组件
 * 头像点击后进入独立页面，左侧导航，右侧内容区域
 */
class AccountPage {
  constructor(containerEl, editorEl) {
    this._el = containerEl;
    this._editorEl = editorEl;
    this._activeSection = 'mine';
    this._user = this._getUtoolsUser();

    this._render();
    this._bindEvents();
  }

  open() {
    this._user = this._getUtoolsUser();
    this._render();
    this._editorEl?.classList.add('hidden');
    this._el?.classList.remove('hidden');
  }

  close() {
    this._el?.classList.add('hidden');
    this._editorEl?.classList.remove('hidden');
  }

  _render() {
    if (!this._el) return;

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
            <button class="account-page__header-back" type="button" data-action="back">返回编辑器</button>
          </header>

          <section class="account-page__content">
            ${this._renderSection()}
          </section>
        </main>
      </div>
    `;
  }

  _bindEvents() {
    if (!this._el) return;

    eventBus.on('account:open', () => this.open());

    this._el.addEventListener('click', (e) => {
      const navItem = e.target.closest('[data-section]');
      if (navItem) {
        this._activeSection = navItem.dataset.section;
        this._render();
        return;
      }

      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'back') {
        this.close();
        return;
      }

      const theme = e.target.closest('[data-theme-choice]')?.dataset.themeChoice;
      if (theme) {
        this._setTheme(theme);
        this._render();
        return;
      }

      const panelLayout = e.target.closest('[data-side-panel-layout]')?.dataset.sidePanelLayout;
      if (panelLayout) {
        this._setSidePanelLayout(panelLayout);
        this._render();
      }
    });

    this._el.addEventListener('error', (e) => {
      const avatar = e.target.closest?.('.account-page__avatar-img');
      if (!avatar) return;
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

  _renderSection() {
    if (this._activeSection === 'settings') return this._renderSettings();
    if (this._activeSection === 'updates') return this._renderUpdates();
    if (this._activeSection === 'about') return this._renderAbout();
    return this._renderMine();
  }

  _renderMine() {
    const user = this._getUserView();
    return `
      <div class="account-card account-card--profile">
        <div class="account-card__avatar-wrap">
          ${this._renderAvatar('account-page__avatar account-page__avatar--large')}
        </div>
        <div class="account-card__body">
          <div class="account-card__label">uTools 账号</div>
          <h2>${this._escapeHTML(user.name)}</h2>
          <p>${this._escapeHTML(user.status)}</p>
        </div>
      </div>
    `;
  }

  _renderSettings() {
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const sidePanelLayout = this._getSidePanelLayout();
    return `
      <div class="account-card">
        <div class="account-card__label">外观</div>
        <div class="account-card__value">主题设置</div>
        <p>选择适合当前图片处理环境的界面主题。</p>
        <div class="account-page__theme-row">
          <button class="account-page__theme-choice ${theme === 'light' ? 'account-page__theme-choice--active' : ''}" type="button" data-theme-choice="light">浅色</button>
          <button class="account-page__theme-choice ${theme === 'dark' ? 'account-page__theme-choice--active' : ''}" type="button" data-theme-choice="dark">深色</button>
        </div>
      </div>

      <div class="account-card">
        <div class="account-card__label">编辑器</div>
        <div class="account-card__value">右侧面板布局</div>
        <p>选择属性和图层的展示方式。Tab 布局更节省空间，上下布局可以同时查看两块内容。</p>
        <div class="account-page__theme-row">
          <button class="account-page__theme-choice ${sidePanelLayout === SIDE_PANEL_LAYOUTS.TABS ? 'account-page__theme-choice--active' : ''}" type="button" data-side-panel-layout="${SIDE_PANEL_LAYOUTS.TABS}">Tab 切换</button>
          <button class="account-page__theme-choice ${sidePanelLayout === SIDE_PANEL_LAYOUTS.SPLIT ? 'account-page__theme-choice--active' : ''}" type="button" data-side-panel-layout="${SIDE_PANEL_LAYOUTS.SPLIT}">上下布局</button>
        </div>
      </div>
    `;
  }

  _renderAbout() {
    return `
      <div class="account-card">
        <div class="account-card__label">产品</div>
        <div class="account-card__value">图片工具箱</div>
        <p>面向 uTools 的轻量图片编辑插件，聚焦打码、裁剪、文字标注和快速导出。</p>
      </div>

      <div class="account-page__grid">
        <div class="account-card">
          <div class="account-card__label">运行环境</div>
          <div class="account-card__value">uTools 插件</div>
          <p>支持从文件匹配、剪贴板和拖拽入口快速进入编辑。</p>
        </div>
        <div class="account-card">
          <div class="account-card__label">版本</div>
          <div class="account-card__value">v0.3</div>
          <p>账户页为后续会员、反馈和偏好设置入口预留。</p>
        </div>
      </div>
    `;
  }

  _renderUpdates() {
    return `
      <div class="updates-list">
        ${updateRecords.map(record => this._renderUpdateRecord(record)).join('')}
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
    if (items.length === 0) return '';

    return `
      <div class="update-record__group update-record__group--${category.key}">
        <div class="update-record__group-title">${this._escapeHTML(category.title)}</div>
        <ul>
          ${items.map(item => `<li>${this._escapeHTML(item)}</li>`).join('')}
        </ul>
      </div>
    `;
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
    const name = user.nickname || user.name || user.userName || user.username || 'uTools 用户';
    const avatar = user.avatar || user.avatarUrl || user.photo || '';
    return {
      name,
      avatar,
      initial: this._getInitial(name),
      status: this._user ? '已连接 uTools 用户信息' : '未获取到 uTools 用户信息',
    };
  }

  _getSectionTitle(section) {
    const titles = {
      mine: '我的',
      settings: '设置',
      updates: '更新记录',
      about: '关于',
    };
    return titles[section] || titles.mine;
  }

  _setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    localStorage.setItem(THEME_VERSION_KEY, THEME_VERSION);
    document.querySelectorAll('.theme-toggle').forEach(el => {
      el.setAttribute('data-theme', theme);
    });
  }

  _setSidePanelLayout(layout) {
    if (!Object.values(SIDE_PANEL_LAYOUTS).includes(layout)) return;

    localStorage.setItem(SIDE_PANEL_LAYOUT_KEY, layout);
    eventBus.emit('sidePanel:layoutChanged', layout);
  }

  _getSidePanelLayout() {
    const saved = localStorage.getItem(SIDE_PANEL_LAYOUT_KEY);
    return Object.values(SIDE_PANEL_LAYOUTS).includes(saved) ? saved : SIDE_PANEL_LAYOUTS.TABS;
  }

  _getUtoolsUser() {
    try {
      if (typeof window.getUtoolsUser === 'function') {
        return window.getUtoolsUser();
      }
      if (typeof utools !== 'undefined' && typeof utools.getUser === 'function') {
        return utools.getUser();
      }
    } catch (e) {
      console.warn('[AccountPage] 获取 uTools 用户信息失败:', e);
    }
    return null;
  }

  _getInitial(name) {
    const text = String(name || '').trim();
    return text ? text.slice(0, 1).toUpperCase() : 'U';
  }

  _escapeAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

export default AccountPage;
