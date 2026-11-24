# 求职准备知识库

YonData 数据智能、数据引擎、在线编程教学平台三个项目的资料站：
每个项目分「项目介绍 / 面试题库 / 通用技术知识」三个分区，共 59 篇文档，
含站内检索、深色主题、mermaid 架构图。

> 本目录是构建产物，由 `docs/yondata-kb/tools/build_site_dist.py --target github` 生成于 2026-11-24。
> **不要手改这里的文件**，下次构建会覆盖。

## 直接看

纯静态、hash 路由，双击 `index.html` 就能打开；也可以起个本地服务：

```bash
python -m http.server 8000
```

## 发布（任选一种，都是从这个仓库拉）

| 方式 | 怎么做 |
|---|---|
| **GitHub Pages** | Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`。访问 `https://<用户名>.github.io/<仓库名>/` |
| **EdgeOne Pages / Vercel / Netlify** | 新建项目 → 连这个仓库 → 构建命令留空、输出目录填 `/` |
| **腾讯云 COS / 云开发** | 把仓库里的文件下载下来上传即可；那是 `--target cos` 产物的同类内容 |

`.nojekyll` 已包含，GitHub Pages 不会走 Jekyll 处理，`assets/` 与中文文件名都能正常访问。

> 国内网络下 `github.com:443` 常常连不上而 `api.github.com` 正常。如果 `git push` 卡在
> 「Could not connect」，把下面的配置加进 `~/.ssh/config` 走 443 端口，通常能通：
>
> ```sshconfig
> Host github.com
>   HostName ssh.github.com
>   Port 443
>   User git
> ```
>
> 若仍失败，换 EdgeOne Pages / Vercel 连 GitHub 仓库，或直接把本目录上传到腾讯云 COS。

## AI 能力

站内检索、文档浏览、深色主题完全可用。框选改写可在 AI 面板设置里填
「直连接口（OpenAI 兼容）」并自带 Key（只存浏览器 localStorage），不填则走离线规则。
**AI 助手（工具调用、会话历史）需要服务端的 `kb_server.py`，纯静态托管下不可用**，
面板会直接说明这一点。

## 更新

在源工作区改完 Markdown 后：

```bash
python docs/yondata-kb/tools/build_kb.py                    # Markdown → content.js
python docs/yondata-kb/tools/build_site_dist.py --target github --git
cd docs/yondata-kb/dist/gh-pages && git push origin main    # 推到发布仓库
```

只有 `content.js` 会随文档变化，其他文件基本不动，所以每次提交都很小。
