# Open WebBridge — 用户手册

[English](README.md) | **中文**

Open WebBridge 是一款本地工具,让 AI 助手操作你**真实的 Chrome 浏览器**。它可以
打开网页、读取页面内容、点击、输入、填写并提交表单、下载文件、截图与导出 PDF,
并完成多步骤任务——全部在你**现有的浏览器配置档**中进行,使用你已经登录的会话与
凭据。软件完全运行在你的电脑上,不向任何外部服务发送数据。

本手册涵盖安装、配置、命令行接口、完整的动作列表、常见工作流、远程操作与故障排查。

---

## 目录

1. [概述](#1-概述)
2. [核心能力](#2-核心能力)
3. [典型使用场景](#3-典型使用场景)
4. [系统要求](#4-系统要求)
5. [安装](#5-安装)
6. [核心概念](#6-核心概念)
7. [命令行参考](#7-命令行参考)
8. [动作参考](#8-动作参考)
9. [示例与工作流](#9-示例与工作流)
10. [远程操作](#10-远程操作)
11. [配置与文件位置](#11-配置与文件位置)
12. [更新](#12-更新)
13. [安全与隐私](#13-安全与隐私)
14. [故障排查](#14-故障排查)
15. [卸载](#15-卸载)
16. [许可证](#16-许可证)

---

## 1. 概述

Open WebBridge 由三个部分组成,只需安装一次:

- **后台服务**(一个小型命令行程序):运行在你的电脑上,接收指令。
- **浏览器扩展**:在你的 Chrome 中执行这些指令。
- **可选的 Agent Skill**:教会兼容的 AI 助手如何下达指令。

你——或你的 AI 助手——通过一条命令 `open-webbridge call <action>` 下达指令。
每条指令都在你自己的浏览器中执行,因此 AI 看到的页面和你看到的一样,且已登录。

由于浏览器与服务运行在同一台机器上,且服务不主动对外联网,你的浏览行为与数据
不会离开你的电脑。

## 2. 核心能力

- **操作已登录的站点。** 操作在你真实的浏览器配置档中进行,因此 AI 能访问你已
  登录的一切——内部仪表盘、SaaS 应用、管理后台、网页邮箱——无需重新登录或 API 密钥。
- **可靠地读取页面。** AI 收到的是页面的结构化、带标签的清晰大纲(基于无障碍结构),
  并按语义定位元素,因此即便站点样式或标记发生变化,自动化仍能继续工作。
- **像人一样交互。** 点击、在输入框与富文本编辑器中输入、选择下拉项、悬停、滚动、
  按键、拖拽、轻触、上传文件。
- **运行 JavaScript**:在页面上下文中执行,读取值或实现自定义逻辑。
- **捕获输出。** 保存整页或单个元素的截图,导出页面为 PDF。文件写入磁盘并以路径返回。
- **在页面上手工标注。** 直接点击真实页面上的元素并写下评论;AI 读回这些标注时,
  能拿到可用的选择器和该元素的截图,并逐条标记为已处理——让“这里有问题”精确落到
  某个元素上,而不只是一段描述。
- **检查与模拟。** 记录网络请求与响应;模拟设备屏幕尺寸、User-Agent 与地理位置。
- **管理文件与弹窗。** 启动、列出、取消下载;自动处理浏览器原生对话框
  (alert / confirm / prompt),使任务不会卡死。
- **跨框架工作。** 可在嵌入式(含跨域)iframe 内操作,而不仅限于顶层页面。
- **并行执行任务。** 各任务在独立的标签分组(“会话”)中隔离,互不干扰。
- **操作远程浏览器。** 可在服务器或备用机器上运行服务,从你的笔记本或 CI 流水线
  向它下达指令。

## 3. 典型使用场景

- 需要使用实时、已登录网页的 AI 助手——API 无法完成的调研与操作类任务。
- 自动化没有可用 API 的内部门户与 SaaS 界面。
- 从需要登录或依赖 JavaScript 渲染的站点提取数据。
- 周期性网页杂务,如生成并下载报表、填写记录。
- 为留档与审阅生成网页截图或 PDF 副本。
- 检查 Web 应用的网络行为。
- 通过设备与地理位置模拟,验证移动端或特定地区的行为。

## 4. 系统要求

- **操作系统:** macOS 或 Linux。
- **浏览器:** 基于 Chromium 的浏览器(Google Chrome 或 Microsoft Edge)。
- **从源码构建(可选):** 服务需要 Go 1.24 及以上;扩展需要 Node.js 18 及以上。

提供预编译的服务二进制,因此大多数用户无需构建工具链。

## 5. 安装

安装分三步:安装后台服务、添加浏览器扩展、将二者连接。

### 5.1 安装后台服务

运行安装脚本,它会下载适配你平台的预编译二进制并启动服务:

```bash
curl -fsSL https://raw.githubusercontent.com/zhizuzhefu/open-webbridge/main/scripts/install.sh | bash
```

如需安装指定版本,设置 `OWB_VERSION`(例如 `OWB_VERSION=v1.0.2`)。
若想从源码构建,克隆仓库后运行 `./scripts/dev-install.sh`。

程序会安装到 `~/.open-webbridge/bin/open-webbridge`。为方便使用,将其加入 `PATH`:

```bash
export PATH="$PATH:$HOME/.open-webbridge/bin"
```

### 5.2 安装浏览器扩展

任选其一:

- **Chrome 应用商店**(推荐;自动更新):从商店页面安装 Open WebBridge 扩展。
- **手动安装:** 构建扩展并以「加载已解压」方式载入。

  ```bash
  cd open-webbridge-extension
  npm install
  npm run build          # 生成 dist/ 目录
  ```

  然后打开 `chrome://extensions`,开启**开发者模式**,点击**加载已解压的扩展程序**,
  选择 `dist/` 目录。

### 5.3 连接扩展

1. 打印连接链接(其中包含你机器的访问令牌):

   ```bash
   open-webbridge url
   # ws://127.0.0.1:9234/ws?token=…
   ```

2. 点击浏览器工具栏的 Open WebBridge 图标,将链接粘贴到输入框并点击 **Connect**。
   状态指示点变绿即成功。

此后扩展会记住链接并自动重连。

### 5.4 验证安装

```bash
open-webbridge status
```

正常结果应显示 `"running": true` 与 `"extension_connected": true`。

## 6. 核心概念

**会话(Session)。** 每条指令都归属于一个会话,通过 `--session` 命名。每个会话对应
浏览器中一组独立的标签页,从而隔离并行任务。若省略 `--session`,则使用 `default` 会话。

**元素引用(Element references)。** `snapshot` 动作返回页面的文本大纲,其中可交互元素
被标注为 `@e1`、`@e2` 等。将这些标签传给 `click`、`fill` 等动作。由于这些标签来自页面
的无障碍结构而非 CSS,它们在站点外观变动后仍然有效。页面变化后请重新 `snapshot`。

**捕获的文件。** 截图与 PDF 写入 `~/.open-webbridge/files/`,动作返回文件路径,从而
不会内联返回庞大的图像数据。

**访问令牌(Access token)。** 首次运行时生成、保存在配置文件中的密钥令牌,是每条指令
的必备凭据。命令行工具会自动附带它。这可防止你机器上的其它程序或网页驱动你的浏览器。

## 7. 命令行参考

通用形式:

```bash
open-webbridge <command> [options]
```

| 命令 | 说明 |
|------|------|
| `start [--host H] [--port N]` | 启动后台服务。`--host` 与 `--port` 会写入配置。 |
| `stop` | 停止服务。 |
| `restart` | 重启服务。 |
| `status` | 以 JSON 打印服务与连接状态。 |
| `url` | 打印供扩展使用的连接链接(含令牌)。 |
| `token` | 打印访问令牌。 |
| `logs [-n N] [-f]` | 显示最近 `N` 行日志;`-f` 实时跟随。 |
| `update [--check] [--force]` | 更新服务到最新发布版本。`--check` 仅检查是否有更新。 |
| `bind <host> [--port N]` | 设置网络绑定(`local`/`127.0.0.1` 或 `remote`/`0.0.0.0`)并重启。见[远程操作](#10-远程操作)。 |
| `call <action> [options]` | 执行一个浏览器动作(见下)。 |
| `version` | 打印版本。 |
| `help` | 显示用法。 |

### `call` 命令

```bash
open-webbridge call <action> [--session NAME] [--args '<json>'] [json] \
                             [--daemon URL] [--token TOKEN]
```

| 选项 | 说明 |
|------|------|
| `<action>` | 要执行的动作(见[动作参考](#8-动作参考))。 |
| `--session NAME` | 操作所在的会话(标签分组)。默认 `default`。 |
| `--args '<json>'` | 动作参数,JSON 对象。也可作为末尾的 JSON 字符串给出。 |
| `--daemon URL` | 将指令发往远程服务而非本地服务。也可用环境变量 `OWB_DAEMON` 设置。 |
| `--token TOKEN` | 远程服务的访问令牌。也可用环境变量 `OWB_TOKEN` 设置。 |

命令打印形如 `{"ok": true, "data": …}` 或 `{"ok": false, "error": "…"}` 的 JSON 结果,
失败时以非零状态码退出。

### `status` 结果字段

| 字段 | 含义 |
|------|------|
| `running` | 服务正在监听。 |
| `host`、`port` | 服务绑定的地址。 |
| `remote` | 指令端点是否暴露到回环地址之外。 |
| `version` | 服务版本。 |
| `extension_connected` | 浏览器扩展是否已连接。 |
| `extension_version` | 扩展上报的版本。 |
| `extension_compatible` | 扩展的协议版本是否与守护进程一致。 |
| `uptime_seconds` | 服务运行时长。 |

## 8. 动作参考

所有动作均通过 `open-webbridge call` 调用,参数以 JSON 对象经 `--args` 传入。许多元素类
动作还接受可选的 `frame` 参数(由 `frames` 获得的框架标识),用于在嵌入式 iframe 内操作。

### 导航与标签

| 动作 | 参数 | 返回 |
|------|------|------|
| `navigate` | `url`(字符串,必填);`newTab`(布尔);`group_title`(字符串) | `{ url, tabId, title }` |
| `find_tab` | `url`(字符串,URL 或域名,必填);`active`(布尔) | `{ url, tabId }` |
| `list_tabs` | — | `{ tabs: [ { tabId, url, title, active, groupTitle } ] }` |
| `list_sessions` | — | `{ sessions: [ { session, groupId, color, tabCount, orphaned } ] }` |
| `activate_tab` | `tabId`(数字,可选) | `{ tabId }` |
| `close_tab` | — | `{ closed }` |
| `close_session` | `groupId`(数字,可选) | `{ closed }` |

会话的第一次 `navigate` 请用 `newTab: true`。任务结束时调用 `close_session`。

会话状态只存在于浏览器的标签分组里(分组标题即会话名),因此 service worker
重载、扩展更新或守护进程重启都可能留下“无主”的遗留分组。现在在
`navigate`/`list_tabs`/`close_session` 之前,扩展会先把会话与 Chrome 中实际存活的
分组进行对账(reconcile),从而按名字重新接管遗留分组,而不会再新建重复分组。用
`list_sessions` 可列出全部分组(无主分组会标记 `orphaned: true`),用带 `groupId`
的 `close_session` 可精确关闭某一个分组。

### 读取页面

| 动作 | 参数 | 返回 |
|------|------|------|
| `snapshot` | `frame`(字符串,可选) | `{ url, title, frame, refCount, tree }` |
| `evaluate` | `code`(字符串,必填);`frame`(字符串,可选) | `{ type, value }` |
| `frames` | — | `{ tabId, count, frames: [ { targetId, type, url, title, attached } ] }` |

`snapshot` 是读取页面与定位元素的首选。`evaluate` 运行 JavaScript 并返回其(可 JSON 序列化的)
结果,支持 `await`。

### 交互

| 动作 | 参数 | 返回 |
|------|------|------|
| `click` | `selector`(`@eN` 引用或 CSS,必填);`frame` | `{ tag, text, method }` |
| `fill` | `selector`(必填);`value`(字符串);`frame` | `{ mode, tag }` |
| `hover` | `selector`,或 `x` 与 `y`;`frame` | `{ success }` |
| `scroll` | `selector`,或 `x` 与 `y`;`frame` | `{ success, mode }` |
| `press_key` | `key`(如 `Enter`、`Tab`、`Escape`、`ArrowDown` 或单个字符);`selector`(可选);`frame` | `{ key }` |
| `select_option` | `selector`(必填);`value` 或 `label`;`frame` | `{ value }` |
| `drag` | `from` 与 `to`(选择器),或 `fromX`/`fromY` 与 `toX`/`toY`;`frame` | `{ from, to }` |
| `tap` | `selector`,或 `x` 与 `y`;`frame` | `{ point, mode }` |
| `upload` | `selector`(必填);`files`(绝对路径数组,必填);`frame` | `{ fileCount }` |

`fill` 会替换已有内容。若要追加,请先用 `evaluate` 读取当前值、拼接后再 `fill`。

### 捕获

| 动作 | 参数 | 返回 |
|------|------|------|
| `screenshot` | `format`(`png` 或 `jpeg`);`quality`(0–100,JPEG 用);`selector`(可选,捕获单个元素) | `{ path, format, sizeBytes }` |
| `save_as_pdf` | `paper_format`(`letter`/`a4`/`legal`/`a3`/`tabloid`);`landscape`(布尔);`scale`(0.1–2.0);`print_background`(布尔);`file_name`(字符串) | `{ path, sizeBytes }` |

### 检查与模拟

| 动作 | 参数 | 返回 |
|------|------|------|
| `network` | `cmd`(`start` / `stop` / `list` / `detail`);`filter`(子串,用于 `list`);`requestId`(用于 `detail`) | 请求/响应数据 |
| `cookies` | `cmd`(`get` / `all`);`domain`(过滤,可选);`urls`(来源,用于 `get`) | `{ count, cookies, header }`——包含 **HttpOnly** Cookie |
| `emulate` | `device` `{ width, height, deviceScaleFactor, mobile }`;`userAgent`(字符串);`geolocation` `{ latitude, longitude, accuracy }`;`clear`(布尔) | `{ applied }` |

对于 `network`,先 `start`,执行活动,再 `list`(可按子串过滤),并用 `detail` 查看具体请求。
对于 `emulate` 的地理位置,站点需已被授予地理位置权限,覆盖才会生效。

`cookies` 通过 DevTools 协议读取浏览器真实的 Cookie jar,因此能拿到 **HttpOnly** Cookie——
即页面 JS(`document.cookie`,也就是 `evaluate`)永远看不到的登录令牌。`cmd:"get"`(默认)返回
当前活动标签页页面作用域内的 Cookie;`cmd:"all"` 返回整个浏览器配置的 Cookie(可用 `domain` 过滤)。
每条 Cookie 都带 `httpOnly`、`secure`、`sameSite`、`expires`;返回值还含一个可直接粘贴的 `header`
字符串,可直接用作请求的 `Cookie:` 头。

### 标注(在页面上手工标记)

标注是**你**在真实页面上留在具体元素上的评论,随后由 AI 读回。它的意义在于:
把“这个按钮坏了”变成挂在那个按钮上的一条记录——带着 AI 可以直接使用的选择器,
以及该元素的截图——而不是一大段文字描述。

| 动作 | 参数 | 返回 |
|------|------|------|
| `annotate` | `mode`(`start` / `stop` / `toggle` / `status` / `locate`);`tabId`(可选);`target`(`"active"` 表示用你正在看的标签页);`all`(布尔,配合 `stop`);`id`(用于 `locate`) | `{ mode, tabId, url, annotations_on_page }` |
| `annotations` | `op`(`list` / `get` / `clear` / `delete` / `resolve` / `reopen` / `note` / `screenshot` / `stats`);`status`(`open` / `resolved` / `all`);`url`、`ids`、`id`、`since`、`limit`;`wait_ms`;`note`;`verbose` | `{ count, annotations, cursor }` |

**开始标注。** 按 `Alt+Shift+A`、在扩展弹窗里点 **Start annotating**,或让 AI 调用
`annotate {"mode":"start"}`。页面随即进入标注模式:悬停会高亮元素,点击某个元素弹出
评论框(⌘/Ctrl+Enter 保存,`⌥↑` 向上选中父元素,Esc 退出)。已有的标注以带编号的
标记点显示,可重新打开、标记解决或删除。

**AI 拿到什么。** 每条标注包含评论、页面 URL,以及一份元素指纹:当前最稳定的
选择器(testid → id → name → aria-label → 结构化路径),外加 XPath、属性、祖先链和
几何位置作为兜底。系统会自动截取该元素的裁剪截图,按需用
`annotations {"op":"screenshot","id":…}` 取回——它会把 JPEG 写入
`~/.open-webbridge/files/` 并返回路径。

**闭环。** `annotations {"op":"resolve","ids":["a3"],"note":"…"}` 把标注标记为已处理
并附上 AI 的回复——页面上的标记点会变绿并显示这条回复,你不用离开浏览器就能看到哪些
问题被处理了。`annotations {"op":"clear"}` 清空全部标注。

标注保存在浏览器配置档中,而不在 daemon 里:页面刷新、跳转、daemon 重启,甚至完全没有
启动 daemon,标注都不会丢,也不会发送到任何地方。
`annotate {"mode":"locate","id":"a3"}` 会在当前页面上重新查找被标注的元素,并报告哪个
选择器仍然命中——页面改版后尤其有用。

### 文件与对话框

| 动作 | 参数 | 返回 |
|------|------|------|
| `download` | `cmd`(`start` / `list` / `cancel`);`url`(用于 `start`);`filename`(可选);`id`(用于 `cancel`);`limit`(用于 `list`) | `{ id }` 或 `{ downloads: [ … ] }` |
| `dialog` | `action`(`accept` / `dismiss`);`promptText`(可选);或 `cmd: "list"` | `{ policy }` 或 `{ dialogs: [ … ] }` |

原生对话框默认自动 dismiss,使自动化不会卡死。若某流程需要接受对话框,先用
`{"action":"accept"}` 调用 `dialog`;用 `{"cmd":"list"}` 查看出现过的对话框。

完整参考(含注意事项与边界情况)见
[`open-webbridge-skill/SKILL.md`](open-webbridge-skill/SKILL.md)。

## 9. 示例与工作流

**读取页面并提取标题:**

```bash
open-webbridge call navigate --session demo --args '{"url":"https://example.com","newTab":true}'
open-webbridge call snapshot --session demo
open-webbridge call evaluate --session demo --args '{"code":"document.title"}'
open-webbridge call close_session --session demo
```

**填写并提交表单**(使用快照中的元素引用):

```bash
open-webbridge call navigate --session form --args '{"url":"https://example.com/login","newTab":true}'
open-webbridge call snapshot --session form          # 找到字段/按钮的引用
open-webbridge call fill  --session form --args '{"selector":"@e3","value":"my-user"}'
open-webbridge call fill  --session form --args '{"selector":"@e4","value":"secret"}'
open-webbridge call click --session form --args '{"selector":"@e5"}'
```

**将页面导出为 PDF:**

```bash
open-webbridge call navigate    --session cap --args '{"url":"https://example.com/report","newTab":true}'
open-webbridge call save_as_pdf --session cap --args '{"paper_format":"a4","file_name":"report"}'
```

**记录网络活动:**

```bash
open-webbridge call network --session net --args '{"cmd":"start"}'
open-webbridge call navigate --session net --args '{"url":"https://example.com"}'
open-webbridge call network --session net --args '{"cmd":"list","filter":"api"}'
```

**直接指着问题,而不是描述问题:**

```bash
# 1. 打开标注模式,然后在页面上点击元素、写下评论
open-webbridge call annotate --args '{"mode":"start"}'

# 2. AI 等待你的标注(不会阻塞它在同一会话上的其他调用)
open-webbridge call annotations --args '{"op":"list","wait_ms":120000,"since":0}'

# 3. 它挑一条,确认元素还在,并读取那张截图
open-webbridge call annotate    --args '{"mode":"locate","id":"a1"}'
open-webbridge call annotations --args '{"op":"screenshot","id":"a1"}'

# 4. 它把结论写回标注本身,你会看到页面上的标记点变绿
open-webbridge call annotations --args '{"op":"resolve","ids":["a1"],"note":"已修复"}'
open-webbridge call annotations --args '{"op":"clear"}'
```

**并行执行两个任务**,使用不同的会话名:

```bash
open-webbridge call navigate --session research --args '{"url":"https://news.example","newTab":true}'
open-webbridge call navigate --session filing   --args '{"url":"https://admin.example","newTab":true}'
```

## 10. 远程操作

浏览器与服务始终运行在同一台机器上。若要从别处操作该机器的浏览器,只需暴露指令端点:

```bash
# 在运行 Chrome 的机器上:
open-webbridge bind remote      # 将指令端点绑定到所有网络接口
open-webbridge token            # 记下访问令牌
open-webbridge bind local       # 用完后恢复为仅本地
```

从另一台机器,将 `call` 指向远程服务:

```bash
open-webbridge call snapshot --session work \
  --daemon http://<远程主机>:9234 --token <令牌>
```

服务与浏览器之间的控制通道始终仅限本机,因此远程一方永远无法冒充浏览器接入。
远程指令流量以令牌鉴权但**未加密**;请仅在可信网络中使用,或通过 SSH 隧道转发。
详见
[`open-webbridge-skill/references/operations.md`](open-webbridge-skill/references/operations.md)。

## 11. 配置与文件位置

所有数据存放于 `~/.open-webbridge/`:

```
~/.open-webbridge/
├── bin/open-webbridge      服务 / 命令行程序
├── config.json             配置(权限 0600)
├── daemon.pid              运行中服务的进程号
├── logs/daemon.log         活动日志
└── files/                  保存的截图与 PDF
```

`config.json` 字段:

| 字段 | 默认值 | 含义 |
|------|--------|------|
| `host` | `127.0.0.1` | 指令端点的网络绑定。 |
| `port` | `9234` | TCP 端口。 |
| `token` | 自动生成 | 每条指令所需的访问令牌。 |
| `auto_update` | `false` | 为 `true` 时,服务在每日检查中自动安装新版本。 |

请在服务停止时编辑该文件,然后 `open-webbridge start`。

## 12. 更新

```bash
open-webbridge update --check     # 检查是否有更新
open-webbridge update             # 安装最新版本并重启
```

服务也会每日检查更新并在日志中记录是否可用;将 `auto_update` 设为 `true` 可自动应用更新。
浏览器扩展通过 Chrome 应用商店更新。

守护进程与扩展**各自独立发版**——分别走 GitHub Releases 和 Chrome 应用商店,版本号
无需一致。兼容性由两者连接时交换的一个小小的**协议版本**决定,只有在消息格式发生
不兼容变更时才会改动。因此**日常更新守护进程不会强制更新扩展**(反之亦然)。一旦协议
版本不一致,连接会被拒绝,并提示你该升级哪一侧。

## 13. 安全与隐私

- 服务完全运行在你的机器上,默认不发起任何对外连接。
- 代码中不含任何形式的分析或使用情况上报。
- 每条指令都需要配置文件中的访问令牌,而该文件仅你的账户可读。这可防止本机其它程序
  或网页控制你的浏览器。
- 即便启用了远程指令,服务与浏览器之间的通道仍仅限本机。
- `open-webbridge logs` 会记录其执行过的操作。

由于动作在你真实的浏览器配置档中执行,你授权的 AI 助手会以你已登录的会话身份行事。
只把权限授予你信任的助手,不需要时请停止服务(`open-webbridge stop`)。

完整隐私政策见 [Privacy Policy](PRIVACY.md)。

## 14. 故障排查

| 现象 | 解决 |
|------|------|
| `command not found` | 未安装,或其目录不在 `PATH` 中。重新运行安装脚本,或用完整路径调用:`~/.open-webbridge/bin/open-webbridge`。 |
| `status` 显示 `"running": false` | 启动它:`open-webbridge start`。 |
| `status` 显示 `"extension_connected": false` | 打开浏览器,确认扩展已安装并已连接(见 [5.3](#53-连接扩展))。 |
| 调用返回 `no browser extension connected` | 同上——连接扩展。 |
| 调用返回 `invalid or missing token` | 扩展弹窗中的链接已过期。重新运行 `open-webbridge url` 并粘贴新链接。 |
| 调用返回 `unknown element ref …` | 自上次快照后页面已变化。重新 `snapshot` 并使用新引用。 |
| `start` 报告端口被占用 | 端口被其它程序占用。修改 `config.json` 中的 `port` 后重启,或释放该端口。 |
| 加载后扩展卡片显示错误 | 重新构建(`npm run build`)并在 `chrome://extensions` 中重载。 |
| 调用超时 | 用 `open-webbridge logs -n 100` 查看近期活动;无法加载完成的页面会阻塞导航。 |
| macOS:`killed: 9` / 「无法打开」 | 二进制丢了签名(例如用浏览器下载会被加隔离属性)。重跑安装脚本,或手动修复:`xattr -dr com.apple.quarantine ~/.open-webbridge/bin/open-webbridge && codesign --force --sign - ~/.open-webbridge/bin/open-webbridge`。 |

## 15. 卸载

1. 停止服务:`open-webbridge stop`。
2. 在 `chrome://extensions` 中移除扩展。
3. 删除数据目录:`rm -rf ~/.open-webbridge`。
4. 如曾安装 Agent Skill,删除其目录(例如 `~/.claude/skills/open-webbridge`)。

## 16. 许可证

版权所有 (C) 2026 zhizuzhefu (https://github.com/zhizuzhefu)。

Open WebBridge 是自由软件,依据 **GNU Affero 通用公共许可证 v3.0 或更新版本
(AGPL-3.0-or-later)** 授权。你可以在该许可证条款下使用、研究、分享与修改本软件。
特别地,**若你运行修改后的版本以通过网络提供服务,你必须向该服务的用户提供修改后的
源代码**。完整条款见 [LICENSE](LICENSE)。

版权方亦可另行以商业条款授权本软件;若 AGPL 不适合你的用途,请与版权方联系。
