# 后台素材上传器

把文章里的图片，自动上传到后台的指定素材分类。

## 功能

- 输入一个文章 `url`
- 输入一个素材分类名，例如 `动漫男头`、`动漫女头`
- 自动提取正文图片
- 自动排除最后一张图片
- 自动保存到本地目录 `D:\wxgzh-picture`
- 自动进入后台素材库（需要提前登录）
- 自动切换到指定分类
- 自动分批上传并校验数量变化
- 上传前自动等待上传控件就绪，降低“请不要上传空文件”问题

## 目录结构

```text
backend-material-uploader/
  package.json
  README.md
  backend-upload.bat
  scripts/
    backend-material-upload-cli.js
    sync_backend_materials_cdp.js
    select-files-in-open-dialog.ps1
```

## 运行环境

- Windows
- Node.js 18+
- Microsoft Edge
- 已登录后台

## 安装

在项目目录执行：

```bash
npm install
```

## 使用前准备

### 1. 启动 Edge 并开启调试端口

必须用远程调试端口启动 Edge，否则脚本无法接管浏览器。

示例命令：

```bash
msedge.exe --remote-debugging-port=9222
```

如果你的系统里 `msedge.exe` 不在环境变量里，也可以改成完整路径，例如：

```bash
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
```

### 2. 登录后台

在这个 Edge 窗口中先打开：

```text
后台地址
```

并手动完成登录。

## 最简单的用法

### 方式一：双击运行

直接双击：

```text
backend-upload.bat
```

然后按提示输入：

1. 文章链接
2. 素材分类名

例如：

```text
请输入文章链接: https://example.com/article-link
请输入素材分类名: 动漫女头
```

### 方式二：命令行运行

```bash
node scripts/backend-material-upload-cli.js "https://example.com/article-link" "动漫女头"
```

或者：

```bash
npm run upload -- "https://example.com/article-link" "动漫女头"
```

## 高级参数

### 指定每批上传数量

```bash
node scripts/backend-material-upload-cli.js "https://example.com/article-link" "动漫男头" --batch-size 9
```

### 只上传本地目录现有图片，不重新采图

```bash
node scripts/backend-material-upload-cli.js "" "动漫男头" --action upload-only --start-from 10
```

### 只切换分类，不上传

```bash
node scripts/backend-material-upload-cli.js "https://example.com/article-link" "动漫男头" --action select-group-only
```

### 指定调试端口

如果你不是用 `9222`，可以这样改：

```bash
node scripts/backend-material-upload-cli.js "https://example.com/article-link" "动漫男头" --port 9333
```

### 指定已有的 WebSocket 调试地址

```bash
node scripts/backend-material-upload-cli.js "https://example.com/article-link" "动漫男头" --ws "ws://127.0.0.1:9222/devtools/browser/xxxx"
```

## 其他人使用时，需要改哪些地方

通常只需要关注下面几个点：

### 1. Edge 调试端口

默认是：

```text
9222
```

如果别人本机用的是别的端口，就要在命令里加：

```bash
--port 9333
```

### 2. Edge 启动命令

不同电脑的 Edge 安装路径可能不一样。

如果 `msedge.exe` 命令不可用，就改成自己电脑上的实际路径。

### 3. 图片输出目录

默认输出目录是：

```text
D:\wxgzh-picture
```

如果别人电脑没有 `D:` 盘，建议改成自己存在的目录，例如：

```bash
--output-dir "C:\backend-materials"
```

### 4. 浏览器必须已登录后台

脚本不会替用户扫码登录。

如果没有提前登录，脚本会失败。

### 5. 素材分类必须已存在

你当前的前提是“类别一定存在”。

所以别人也要保证后台里已经有这个分类。


## 常见问题

### 1. 为什么脚本连不上浏览器？

通常是因为 Edge 不是通过远程调试端口启动的。

### 2. 为什么脚本提示未登录？

因为当前可见 Edge 窗口里还没有登录后台。

### 3. 为什么上传到了错误分类？

当前脚本已经做了分类切换校验，但前提仍然是该分类真实存在且页面可操作。

### 4. 为什么上传数量和预期不一致？

素材库有时会异步入库，数量变化可能不是瞬时完成。

### 5. 为什么会提示“请不要上传空文件”？

这通常是因为页面上传控件还没准备好，就太快把文件塞进去了。

当前发布版脚本已经补了三层保护：

1. 点击“上传”后，先等待上传输入框就绪
2. 设置文件后额外停顿，等待页面接收文件
3. 每批上传完成后再冷却一小段时间再继续下一批

