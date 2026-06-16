export const updateRecords = [
  
  {
    version: '2.1.1',
    date: '2026-06-15',
    changes: {
      added: [
        { text: '马赛克工具新增自由选区模式，支持非矩形区域马赛克/模糊', platforms: null }
      ],
      fixed: [
        { text: '修复橡皮擦擦除画笔图层后，图层名称被错误重置为马赛克的问题', platforms: null }
      ],
      improved: [
        { text: '优化打码画笔模式，鼠标悬停/涂抹时显示画笔位置，涂抹过程中实时显示打码效果', platforms: null },
        { text: '优化图层默认名称展示，文字/画笔/马赛克图层会按内容和预设生成更清晰的名称', platforms: null }
      ],
      adjusted: [
        { text: '马赛克图层改为动态重算，移动图层时会根据新的下方内容重新生成效果', platforms: null },
        { text: '马赛克工具默认预设调整为矩形 + 中马赛克', platforms: null }
      ],
      removed: []
    }
  },
  {
    version: '2.1',
    date: '2026-06-13',
    changes: {
      added: [
        { text: '新增画笔工具，支持自由涂鸦、颜色预设和粗细调整', platforms: null },
        { text: '新增橡皮擦工具，支持大小预设和撤销/重做', platforms: null },
        { text: '新增非矩形裁剪工具', platforms: null },
        { text: '文字字体列表支持读取并显示用户系统中已安装的字体', platforms: ['utools'] },
        { text: '移动/框选预设栏新增旋转0°/90/180/270与左右/前后翻转快捷操作', platforms: null }
      ],
      fixed: [],
      improved: [
        { text: '优化了裁剪工具的使用体验', platforms: null },
        { text: '字体列表按用户实际使用频率自动排序', platforms: ['utools'] }
      ],
      adjusted: [],
      removed: []
    }
  },
  {
    version: '2.0',
    date: '2026-06-12',
    changes: {
      added: [
        { text: '右侧面板新增切换状态，可切换tab布局或上下布局', platforms: null },
        { text: '新增"预设栏"和"状态栏"位置切换功能', platforms: null },
        { text: '新增属性/图层面板位置切换，可将侧栏移到左侧', platforms: null }
      ],
      fixed: [
        { text: '修复首次裁剪后再次剪切时，裁剪框被上一轮裁剪范围裁掉的问题', platforms: null },
        { text: '修复第二次裁剪被错误重置为原图范围、未基于首次裁剪继续裁剪的问题', platforms: null },
        { text: '修复旋转裁剪框后应用剪切仍按未旋转矩形生效的问题', platforms: null },
        { text: '修复裁剪后打码拖选框被错误裁掉、不能显示到图像外的问题', platforms: null }
      ],
      improved: [],
      adjusted: [
        { text: '将深色浅色切换调整到了"设置"页面', platforms: null },
        { text: '将"选项栏"与"属性栏"合并', platforms: null },
        { text: '原"选项栏"调整为"预设栏"', platforms: null }
      ],
      removed: [
        { text: '移除了"剪切"工具属性的异常参数', platforms: null }
      ]
    }
  },
  {
    version: '1.0',
    date: '2026-06-10',
    changes: {
      added: [
        { text: '发布了第一个可用版本，支持图片导入、打码、裁切、文字标注和导出', platforms: null },
        { text: '搭建五区编辑器布局：工具栏、选项栏、画布区、属性/图层面板和状态栏', platforms: null }
      ],
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

/**
 * 平台常量
 * null: 所有平台通用
 * ['utools']: 仅 uTools
 * ['ztools']: 仅 ZTools
 * ['utools', 'ztools']: uTools 和 ZTools
 */
export const PLATFORMS = {
  ALL: null,           // 所有平台
  UTOOLS: 'utools',    // uTools 专用
  ZTOOLS: 'ztools',    // ZTools 专用
  LOCAL: 'local',      // 本地环境
};
