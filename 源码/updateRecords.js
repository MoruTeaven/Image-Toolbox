export const updateRecords = [
  
  {
    version: '2.0',
    date: '2026-06-11',
    changes: {
      added: ['右侧面板新增切换状态','新增"我的"页面', '新增"设置"页面'],
      fixed: [],
      improved: [],
      adjusted: ['将深色浅色切换调整到了“设置”页面','将”选项栏“与”属性栏“合并', '原”选项栏“调整为”预设栏“'],
      removed: ['移除了“剪切”工具属性的异常参数']
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
  { key: 'fixed', title: '修复' },
  { key: 'improved', title: '优化' },
  { key: 'adjusted', title: '调整' },
  { key: 'removed', title: '去除' }
];
