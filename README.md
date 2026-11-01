# 装备栏（dsh-loadout）

<img src="docs/icon.png" width="72" align="right" alt="装备栏图标">

[English](README.en.md) · [更新日志](CHANGELOG.md) · MIT

> 「装备栏」是这个插件本身；「套装」是栏里那几套配好的工具。一个对话选一套装备，只带用得上的工具。

DeepSeek Harness 的工具是全局可见的：插件装得越多，每个对话要背的工具清单越长，模型也越容易挑错工具。装备栏把工具编成**套装**，每个对话只留当前套装里的工具。

## 它做什么

| 能力 | 说明 |
| --- | --- |
| 三档底座 | `全部`（不裁剪，默认）/ `仅内置`（只留 DSH 自带工具）/ `我的套装` |
| 加挂 | 在底座之上临时加挂插件，不必为一次性组合新建套装 |
| 预置套装 | 写作 / 调研 / 编程，只读；改动会另存为你的套装 |
| 备注 | 每个套装可加 20 字备注，菜单里显示成 `测试1（用于视频制作）` |
| 刷新 | 菜单右上 `⟳` 重拉工具目录并重套用当前选择 |
| 每对话独立 | 切换只影响当前对话，下一条消息即按新清单组装；新对话用「设置 → 装备栏」的默认套装 |

## 安装

推荐让 Harness 自己装（会创建**链接**，而不是拷贝）：

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

或走 CLI：

```bash
dsh plugin --profile desktop add link:<本目录绝对路径>
```

装完重启应用：宿主插件没有热重载，界面至少刷新一次。

### 为什么不能复制文件

0.4.0 的启动崩溃就是这么来的：`install.ps1` 把文件拷进 profile，源码修好后 profile 里还是旧拷贝，启动时跑的是旧 bundle。链接安装没有这个问题。

自检：

```bash
node scripts/preflight.mjs   # 校验 id/包名一致、补丁行、以及安装副本是否漂移
node scripts/selftest.mjs    # 宿主逻辑：底座/加挂/保存/存储往返/遮罩
node scripts/client-smoke.mjs # 浏览器 bundle：菜单与设置页渲染
```

## 使用

- 标题栏「装备栏」按钮：切底座、加挂插件、新建套装。
- 设置 → 装备栏：管理套装、改备注、选新对话默认套装。
- `/kit <名字>`：在对话里直接切换。

设置页没有自己的对话，所以它只管「新对话从哪套开始」，不切换当前对话——当前对话请在标题栏里切。默认列表里「全部 / 仅内置」和套装是同一种卡片：都能「复制切换命令」或「设为默认」；「我的套装」默认折叠，只显示当前默认的那一个，点开才列出全部。已经保存的套装可以在卡片上「编辑」：改动就在那张卡片下面展开，「覆盖保存」（正在用它的对话立刻按新工具集走）或「另存为新套装」。

### 预置套装里有什么

> 0.10.2 起，**界面暂时不展示预置套装**（标题栏菜单和设置页都不出现）。三套数据仍在 `cordis.patch.yml` 里、`/kit 写作` 这类命令也照常可用，保留给自己测试；等它们对用户足够直观再放出来。下面表格记录它们的内容，方便核对。

三套都是只读的，改动会另存为你的套装。它们只列**内置工具**，插件工具要靠「加挂」或另存时勾选。

| 套装 | 内置工具 |
| --- | --- |
| 写作 | `read` `write` `edit` `glob` `grep` + 协作五件套 |
| 调研 | `web_search` `web_fetch` `read` `glob` `grep` + 协作五件套 |
| 编程 | `pwsh` `read` `write` `edit` `glob` `grep` `todo_write` + 协作五件套 |

「协作五件套」= `send_message` `list_agents` `interrupt_agent` `subagent` `subagent_fork`。每套都带着它们，否则子代理切到这套之后连回话都发不出来。

### 给模型用的工具

`kit_list`（列出套装与当前选择）、`kit_apply`（切到某套）、`kit_create` / `kit_set_tools` / `kit_set_default` / `kit_delete`（增删改）。这些工具在任何套装里都保留，不会把自己锁死。

## 升级

- 0.5.x → 0.9.x：包名没变（`dsh-loadout`），直接 `plugin_manager install_bundle` 覆盖即可；套装数据在 `~/.dsh/loadout.json`，不动。
- 0.4.x → 0.9.x：包名从 `dsh-plugin-kits` 改成 `dsh-loadout`，先卸旧的再装新的：

  ```text
  plugin_manager action=remove_bundle target=dsh-plugin-kits
  plugin_manager action=install_bundle target=<本目录绝对路径>
  ```

  旧数据 `~/.dsh/plugin-kits.json` 会被读一次并迁移到 `~/.dsh/loadout.json`。
- 任何版本升级后都**重启应用**：宿主代码没有热重载，只刷新界面不够。


## token 账本

菜单的状态行会说 `当前：编程 · 省 ~1.9k tokens`，设置页顶部给出完整账目：

```text
当前对话保留 18 个工具 · 约 1.1k tokens　·　「全部」约 3.0k tokens　·　本套装省约 1.9k tokens
```

每个套装卡片也标着自己的估价（`≈1.1k tokens`）。算法是**估算**：把每个工具的定义（名字、说明、参数 schema）序列化后除以 3.5 字符/token，只算工具清单这一段——不含对话历史、系统提示或模型缓存的影响。界面上都写了「估算」，不要拿它当账单。「当前对话保留」这一侧直接量的是运行时真正投给模型的 schema，「全部」那一侧来自工具层的定义表。

## 文件

- 套装数据：`~/.dsh/loadout.json`（旧版 `~/.dsh/plugin-kits.json` 只读一次，随后迁移）。
- 卸载：`plugin_manager action=remove_bundle target=dsh-loadout`。

## 已知边界

- 本插件只控制「对话看得到哪些工具」。已启用的插件仍在后台运行；界面插件（侧边栏、主题等）不受影响。
- 看不到「已下载但未启动」插件的工具：工具只在插件 `apply()` 后存在。
- 遮罩是「减法」：内置工具用工具层的 deny 规则隐藏，插件工具用 `tools.restrict({ deny })`。
- 新装（或删掉 `~/.dsh/loadout.json` 后）默认是「全部」；覆盖安装会保留你已选的默认套装。

## 排查

**应用起不来，弹窗写 `web boot: … entry did not activate / dsh-loadout: import failed`**

这是客户端 bundle 没注册成工厂导致的，启动审计对任何没激活的条目都是致命的。按顺序看：

1. `node scripts/preflight.mjs` —— 它会直接告诉你 bundle 的工厂 id 和包名是否一致。不一致就是这一类问题。
2. 确认安装的是**链接**不是拷贝：`preflight` 会打印 `as a link (no copy to drift)`；如果是拷贝，删掉 `node_modules/dsh-loadout` 重新 `install_bundle`。
3. 仍不行就 `remove_bundle` 后重装并重启，别在 profile 里手工改 `package.json` / `cordis.patch.yml`。

**装了但界面没有按钮 / 工具没生效**

- 宿主代码要重启应用才加载；浏览器 bundle 至少刷新一次。
- `GET /dsh-loadout/state` 能返回 JSON 说明宿主在跑；404 说明宿主没加载成功。
- 菜单里点 `⟳` 可以重拉工具目录，不用重启（只对已加载的宿主有效）。

**切换套装后工具全没了**

0.7/0.8 的 allow 名单缺陷已修，现在只做 deny 遮罩。若仍遇到，点「全部」即可恢复，并把 `/dsh-loadout/debug` 的输出留一份。

