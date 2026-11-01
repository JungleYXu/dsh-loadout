# 发布清单（0.11.0）

这份文件记录把 `dsh-loadout` 发布到 npm 与 `awesome-dsh-plugin` 市场所需的全部步骤、已经具备的条件，以及本机做不了的部分。

## 现在处于什么状态

已就绪：

- 版本 `0.11.0`，`npm test` 三套检查全绿（`preflight` / `selftest` / `client-smoke`），工作树干净且已提交。
- 包元数据齐全：`repository` / `homepage` / `bugs` / `author` / `publishConfig`，`files[]` 覆盖运行所需文件（含 `docs/icon.png`、`README.en.md`、`CHANGELOG.md`）。
- CI：`.github/workflows/ci.yml`（Node 20 / 22，无依赖安装，直接 `npm test`）。
- 发布工作流：`.github/workflows/publish.yml`（推 `v*` 标签后从干净 checkout `npm publish --provenance`，凭仓库 secret `NPM_TOKEN`）。
- 市场条目文件：`release/awesome-dsh-plugin/JungleYXu__dsh-loadout.yml`（复制到列表仓库即完成投稿）。
- 中英文 README、图标（`icon.svg` + `docs/icon.png`）、`CHANGELOG.md`。

本机缺少的能力（这三步必须由持凭据的一方执行）：

| 步骤 | 为什么本机做不了 |
| --- | --- |
| 创建 GitHub 仓库 | 没有 GitHub token；`gh` 未安装。SSH 密钥已授权为 `JungleYXu`，**仓库一旦存在就能直接 push**。 |
| `npm publish` | 没有 npm CLI 与 `~/.npmrc`，且本机到 `registry.npmjs.org` 超时（`registry.npmmirror.com` 可达）。 |
| 向列表仓库提 PR | 需要 fork + PR，两者都要 GitHub API 凭据。 |

另外市场有一条硬规则：**仓库创建满 1 天**才会通过 PR 的 CI（提交数没有门槛）。也就是说，仓库今天创建，最早明天才能被收录。

## 第 1 步：创建仓库并推送

有 `gh` 的机器上：

```bash
gh repo create JungleYXu/dsh-loadout --public --source=. --remote=origin --push
```

没有 `gh` 时，先在网页建一个空仓库（不要勾选 README / .gitignore / license），然后：

```bash
git remote add origin git@github.com:JungleYXu/dsh-loadout.git
git push -u origin main
git push origin v0.11.0
```

本机 SSH 已可用（`ssh -T git@github.com` 返回 `Hi JungleYXu!`），所以只要仓库存在，推送本身不需要额外凭据。

## 第 2 步：发布到 npm（可选，但推荐）

列表允许只发 GitHub、不发 npm（条目里用 `tarball:` 指向 GitHub Release 亦可）。不发 npm 时用户装的是：

```text
dsh plugin --profile web add github:JungleYXu/dsh-loadout
```

发 npm 的好处是安装免构建授权。两条路，任选一条：

**A. 用仓库里的工作流（推荐，不需要本机网络）**

1. 在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`（npm 账号的 automation token）。
2. 推送标签，工作流会跑测试并发布：

   ```bash
   git push origin v0.11.0
   ```

**B. 在能访问 npmjs 的机器上手工发布**

```bash
npm publish --access public
```

发布后可用 `dsh plugin --profile web add dsh-loadout` 安装。

## 第 3 步：提交市场条目

1. Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`。
2. 把本仓库的 `release/awesome-dsh-plugin/JungleYXu__dsh-loadout.yml` 复制为对方仓库的 `data/plugins/JungleYXu__dsh-loadout.yml`（文件名必须是 `<owner>__<repo>.yml`）。
3. 提交并向 `main` 开 PR，标题可以是 `Add JungleYXu/dsh-loadout`。

条目只允许这些键：`url`、`name`、`category`、`description`（`en` 必填，`zh` 可选）、`tarball`（可选）。**不要写 `npm:`**——npm 映射由 CI 从仓库自动解析。

对方的 CI 会检查：

- 仓库里有 `dsh` bundle 声明（本仓库 `package.json` 的 `dsh.bundle.patch` ✔）。
- 仓库创建满 1 天（这条只能等）。
- 文件名字与 `url` 推导出的 slug 一致。
- README 由 `data/plugins/*.yml` 生成——**不要手改 README**。

合并后列表站点与市场在下一次构建时收录（通常一天内）。

## 第 4 步：发布后自检

在任意机器上：

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>     # 或 npm / github: 安装
node scripts/preflight.mjs                                      # id 与包名一致、链接安装
```

然后重启应用，确认标题栏出现「装备栏」按钮、`GET /dsh-loadout/state` 返回 JSON、设置页出现「装备栏」。

## 版本tag

```bash
git tag -a v0.11.0 -m "dsh-loadout 0.11.0"   # 已创建
git push origin v0.11.0
```
