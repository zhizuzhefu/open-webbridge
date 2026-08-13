# Privacy Policy — Open WebBridge

_Last updated: 2026-05-29_

Open WebBridge is a local browser-automation tool consisting of a Chrome
extension and a companion program (the "daemon") that runs on the same computer.
This policy explains what the software does and does not do with your data.

## Summary

**Open WebBridge does not collect, transmit, or sell any personal data.** It has
no analytics, no telemetry, and no remote servers operated by the developer. All
processing happens locally on your own machine.

## What data is processed, and where

- **Web page content and actions.** To carry out the tasks you (or an AI agent
  you authorize) request, the extension reads page content and performs actions
  such as clicking and typing in your browser tabs. This information is used only
  to execute those requests and is **not** sent to the developer or any third
  party. It stays on your computer.
- **Connection settings.** The extension stores the local connection address and
  access token in the browser's local extension storage so it can reconnect.
- **Captured files.** Screenshots and PDFs you request are written to a folder on
  your own computer (`~/.open-webbridge/files/`). They are not uploaded anywhere.
- **Annotations.** If you use annotation mode, the comments you write, a
  description of the element you attached them to, and a cropped screenshot of
  that element are stored in the browser's local extension storage on your own
  computer. They stay there until you clear them, and are readable only by the
  local daemon on your machine.

## Network connections

The extension connects **only** to the Open WebBridge daemon running on your own
machine (the loopback address `127.0.0.1`). The daemon makes no outbound
connections of its own except, when you explicitly run the update command, to
GitHub to download a new version of the daemon.

If you choose to enable remote operation, you may direct the command interface to
a daemon on another machine that **you** control; even then, no data is sent to
the developer or to any third party.

## Browser permissions and why they are needed

- **`debugger`** — to drive pages through the browser's developer protocol, which
  is the core function of the tool.
- **`tabs`, `tabGroups`, `windows`, `activeTab`** — to open, group, activate, and
  manage tabs for each task.
- **`scripting`** — to inject the annotation overlay into a page, and only into
  a page you explicitly put into annotation mode.
- **`storage`** — to remember the local connection address and token.
- **`alarms`** — to keep the background connection alive and reconnect.
- **`downloads`** — to start and track file downloads you request.
- **Host access (`<all_urls>`)** — because automation may operate on any site you
  navigate to. Access is exercised only to perform the actions you request.

## Third parties

Open WebBridge uses no third-party analytics, advertising, or tracking services,
and shares no data with anyone.

## Changes to this policy

Updates to this policy will be published in the project repository at
<https://github.com/zhizuzhefu/open-webbridge>.

## Contact

Questions or concerns: please open an issue at
<https://github.com/zhizuzhefu/open-webbridge/issues>.

---

# 隐私政策 — Open WebBridge

_最后更新:2026-05-29_

Open WebBridge 是一款本地浏览器自动化工具,由一个 Chrome 扩展和一个运行在同一台
电脑上的配套程序(“守护进程”)组成。本政策说明本软件如何处理(以及不处理)你的数据。

## 概要

**Open WebBridge 不收集、不传输、不出售任何个人数据。** 它没有任何分析统计、没有
遥测、也没有由开发者运营的远程服务器。所有处理都在你自己的电脑本地完成。

## 处理哪些数据、在哪里处理

- **网页内容与操作。** 为完成你(或你授权的 AI 助手)的请求,扩展会读取页面内容并
  在你的标签页中执行点击、输入等操作。这些信息仅用于执行你的请求,**不会**发送给
  开发者或任何第三方,始终留在你的电脑上。
- **连接设置。** 扩展会将本地连接地址与访问令牌保存在浏览器的本地扩展存储中,以便
  重新连接。
- **捕获的文件。** 你请求的截图与 PDF 会写入你自己电脑上的目录
  (`~/.open-webbridge/files/`),不会上传到任何地方。
- **标注。** 若你使用标注模式,你写下的评论、所标注元素的描述,以及该元素的裁剪截图,
  都保存在你自己电脑上浏览器的本地扩展存储中。它们会一直保留直到你清空,且只有你本机的
  daemon 能读取。

## 网络连接

扩展**仅**连接到运行在你自己机器上的 Open WebBridge 守护进程(回环地址
`127.0.0.1`)。守护进程自身不发起任何对外连接,唯一例外是:当你主动运行更新命令时,
它会访问 GitHub 以下载新版本。

若你选择启用远程操作,你可以把指令接口指向**你自己**控制的另一台机器上的守护进程;
即便如此,也不会有任何数据发送给开发者或第三方。

## 浏览器权限及其用途

- **`debugger`** — 通过浏览器开发者协议驱动页面,这是本工具的核心功能。
- **`tabs`、`tabGroups`、`windows`、`activeTab`** — 为每个任务打开、分组、激活和管理标签页。
- **`scripting`** — 把标注浮层注入页面,且只注入你明确开启标注模式的页面。
- **`storage`** — 记住本地连接地址与令牌。
- **`alarms`** — 保持后台连接存活并重连。
- **`downloads`** — 启动并跟踪你请求的文件下载。
- **主机访问(`<all_urls>`)** — 因为自动化可能作用于你访问的任意站点;仅在执行你的
  请求时才会使用该访问权限。

## 第三方

Open WebBridge 不使用任何第三方分析、广告或追踪服务,也不与任何人共享数据。

## 政策变更

本政策的更新将发布于项目仓库:<https://github.com/zhizuzhefu/open-webbridge>。

## 联系方式

如有疑问:请在 <https://github.com/zhizuzhefu/open-webbridge/issues> 提交 issue。
