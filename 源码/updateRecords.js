export const updateRecords = [
  
  {
    version: '2.0',
    date: '2026-06-11',
    changes: {
      added: ['新增背景图层展示和锁定逻辑', '新增工具栏撤销和重做按钮', '新增 Ctrl+Y 重做快捷键'],
      fixed: ['修复图层面板刷新死循环问题', '修复选择图片后画布无显示的问题', '修复主题切换按钮不生效的问题', '修复工具模式下误触发图层选中和拖动的问题', '修复放大后裁剪框消失的问题'],
      improved: ['优化保存到电脑和复制到剪贴板按钮样式', '优化图层面板排序，顶层图层显示在上方'],
      adjusted: ['将 PNG、JPEG、WebP 导出按钮合并为一个保存到电脑按钮', '将框选打码和画笔打码合并为一个打码工具'],
      removed: ['移除工具栏中重复的导出按钮', '移除独立的画笔打码入口']
    }
  },
  {
    version: '1.0',
    date: '2026-06-10',
    changes: {
      added: ['发布了第一个可用版本，支持图片导入、打码、裁切、文字标注和导出', '搭建五区编辑器布局：工具栏、选项栏、画布区、属性/图层面板和状态栏'],
      fixed: [],
      improved: [],
      adjusted: [],
      removed: []
    }
  }
];

export const updateCategories = [
  { key: 'added', title: '新增' },
  { key: 'adjusted', title: '调整' },
  { key: 'fixed', title: '修复' },
  { key: 'improved', title: '优化' },
  { key: 'removed', title: '去除' }
];
