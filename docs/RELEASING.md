# 发版流程

这份文档写给维护者：把一个版本从工作树发到 npm，再更新市场条目。它只描述**步骤和判据**，不记录某台机器、某次操作的过程。

## 0. 前提

- 仓库：`https://github.com/JungleYXu/dsh-loadout`（`main` 分支）
- 发布通道：`.github/workflows/publish.yml`，推 `v*` 标签后在干净 checkout 里执行 `npm publish --provenance`
- 仓库 secret：`NPM_TOKEN`。没有它时工作流会跳过发布并留一条 notice，不会把标签跑红
- 市场条目：`docs/awesome-dsh-plugin-entry.yml` 是投稿文件的唯一副本，内容就是列表仓库里的 `data/plugins/JungleYXu__dsh-loadout.yml`

## 1. 改版本号与日志

1. `package.json` → `version`
2. `CHANGELOG.md` 顶部加一节，写清楚「行为变化 / 修了什么 / 迁移注意」
3. 只有文档变化也要写一节，说明「无行为变化」——npm 的包页展示的是发布时打进 tarball 的 README

## 2. 跑三套自检

```powershell
node scripts/preflight.mjs     # 包结构、工厂 id、patch 行、安装副本是否漂移
node scripts/selftest.mjs      # 宿主：绑定、迁移、套装、路由、工具
node scripts/client-smoke.mjs  # 浏览器半：菜单与设置页渲染
```

三条都必须以 `ok` 结尾。`preflight` 在没有安装本插件的机器上会打印 `note: not installed in the current profile yet` 并继续通过，这是给 CI 用的。

## 3. 提交并打标签

```powershell
git add -A
git commit -m "<type>: <一句话>"
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话>"
git push origin vX.Y.Z
```

标签是发布开关：推上去就会触发 `publish`。只想合并代码、不想发版时**不要**推标签。

## 4. 确认发布

- `ci` 与 `publish` 两个工作流都要 `success`；`publish` 的日志里应出现
  `npm notice Publishing to https://registry.npmjs.org/` 与
  `Provenance statement published to transparency log`
- npm 包页由包所有者查看最准确；第三方镜像（npmmirror、jsDelivr）通常要几分钟到几十分钟才同步，
  镜像上暂时看不到新版本**不代表**发布失败
- 发布产物里应包含：`index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、
  `docs/icon.png`、`scripts/*.mjs`、三份文档、`LICENSE`（共 15 个文件左右）

本地也可以先自检产物：

```powershell
git archive --format=zip -o dsh-loadout.zip --prefix=dsh-loadout/ HEAD
```

解压后跑 `node scripts/preflight.mjs`，应通过并报出当前版本号。

## 5. 更新市场条目

市场是人工审核的列表：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/*.yml`，README 由脚本生成，**不要手改 README**。

1. 本仓库改 `docs/awesome-dsh-plugin-entry.yml`（`url` / `name` / `category` / `description` / `icon`）
2. 在列表仓库开 PR：把该文件复制为 `data/plugins/JungleYXu__dsh-loadout.yml`
3. 判据：文件名必须等于 `<owner>__<repo>.yml`；`category` 用 `tools`；`description.en` 必填；
   仓库满一天才会通过 PR 的 CI（提交数没有门槛）

## 6. 回滚

npm 上的版本不能删除。发错了就发一个补丁版本，在 `CHANGELOG.md` 里写清楚原因；必要时用
`npm dist-tag add dsh-loadout@X.Y.Z latest` 把 `latest` 指回上一个可用版本。
