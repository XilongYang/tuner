# 朗读跟读 · 发音练习工具

一个**纯静态、零后端、开源可审计**的网页工具，用于日语和英语的朗读跟读与发音评分练习。

- 无框架、无 npm 包、无 CDN 依赖，只有原生 HTML / CSS / JavaScript（ES 模块）
- 可直接部署到 GitHub Pages / Cloudflare Pages
- 所有 Azure 请求从你的浏览器**直接发往 Azure**，不经过任何中转后端

## 功能

1. 粘贴文本 → 点击「拆分」→ 按句末标点（。！？ / .!?）自动分句并编号
2. 每句自动检测语言（ja / en），可手动切换
3. 「朗读」：调用 Azure Neural TTS 播放标准发音（未配置 Key 时降级为浏览器内置语音）
4. 「录音」：用 Web Audio API 采集 16kHz WAV 录制跟读，「回放」试听
5. 「评分」：直连 Azure Pronunciation Assessment（REST），返回综合 / 准确度 / 流利度 / 完整度四项分数，并对每个词按准确度着色，标出漏读 / 多读，悬停可看逐音素分数

## 使用方式

1. 在 [Azure Portal](https://portal.azure.com/) 创建一个 **Speech Service** 资源，获取 **Key** 和 **Region**（如 `eastasia`、`japaneast`）。
2. 打开页面，点右上角「Azure 设置」，填入 Key 和 Region 并保存。
3. 粘贴文本 → 拆分 → 逐句朗读 / 录音跟读。

> 不填 Key 也能用：朗读会自动降级为浏览器内置语音（`speechSynthesis`），质量较低。

## 关于你的 Key（请务必了解）

- Key **仅保存在浏览器 localStorage**，不会上传到任何服务器。
- 本工具没有后端，请求直接从浏览器发往 Azure，因此在开发者工具的 **Network 面板中能看到你的 Key** —— 这是预期行为。这是你自己的 Key，由你自己负责调用与计费。
- 页面提供「清除 Key」按钮，随时可从本地删除。

## 本地运行

因为使用了 ES 模块，需要通过 HTTP 服务打开（不能直接 `file://`）：

```bash
# 任选其一
python3 -m http.server 8000
npx serve
```

然后访问 `http://localhost:8000`。

## 目录结构

```
index.html          页面结构
css/styles.css      设计系统（低饱和冷灰 + 克制橙色强调）
js/segment.js       句子拆分
js/lang.js          语言检测（ja / en）
js/config.js        Azure 凭据管理（localStorage）
js/tts.js           TTS（Azure REST + 浏览器降级）
js/recorder.js      录音（Web Audio → 16kHz WAV）
js/pron.js          发音评估（Azure Pronunciation Assessment REST）
js/app.js           主应用逻辑
```

## 浏览器要求

- 现代浏览器（Chrome / Edge / Safari）
- 录音需要麦克风权限；`getUserMedia` 通常要求 HTTPS 或 `localhost`

## 许可

MIT
