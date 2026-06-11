export const updateRecords = [
  
  {
    version: '2.0',
    date: '2026-06-11',
    changes: {
      added: ['右侧面板新增切换状态，可切换tab布局或上下布局','新增”预设栏“和”状态栏“位置切换功能'],
      fixed: ['修复首次裁剪后再次剪切时，裁剪框被上一轮裁剪范围裁掉的问题', '修复第二次裁剪被错误重置为原图范围、未基于首次裁剪继续裁剪的问题', '修复旋转裁剪框后应用剪切仍按未旋转矩形生效的问题', '修复裁剪后打码拖选框被错误裁掉、不能显示到图像外的问题'],
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
