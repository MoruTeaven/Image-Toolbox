# 图片工具箱 项目记忆

## 项目概述
- uTools 插件，图片编辑助手
- 基于 Fabric.js 5.x
- 纯原生 JS，不引入前端框架

## 布局
- PS 风格五区布局
- 深色主题默认，支持浅色切换（CSS 变量 + data-theme）
- 属性面板在右上方，图层面板在右下方

## 功能路线
- v0.1：打码(马赛克+模糊)、剪切、加字
- v0.2：撤销重做、画笔打码、属性面板、滚轮缩放
- v0.3+：涂鸦、形状、滤镜、贴纸、水印

## 关键设计决策
- 裁剪用 canvas.clipPath（非破坏性）
- 撤销用 JSON 快照
- 图层 = Fabric.js 物件原生 z-order + 轻量 LayerManager
- 每个功能 = 独立 Module 继承 BaseModule
