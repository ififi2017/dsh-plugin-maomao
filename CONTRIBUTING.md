# 贡献指南

欢迎在 Issues 里讨论体验、提出功能建议，或者直接提交 PR。问题报告建议附上 DSH 版本、系统、插件版本、渠道和可复现的步骤。用测试消息和合成 ID 复现，避免上传真实聊天、完整日志、记忆库或凭据。

## 源码入口

| 路径 | 职责 |
| --- | --- |
| `package.json`、`cordis.patch.yml` | DSH bundle 清单、设置页和内置 Agent 预设 |
| `client.js`、`index.mjs` | 原生设置页和仅供实例所有者调用的面板服务 |
| `integrations/maomao-dsh/private-connector/` | Telegram、Lark / 飞书连接器，私聊绑定与路由 |
| `integrations/maomao-dsh/qq-connector/` | QQ 收发、接话判断与群级授权 |
| `integrations/maomao-companion/` | 公共人设与本地记忆、预算、分享等 Python 组件 |
| `docs/promo.html`、`assets/` | 宣传图 HTML 模板和导出的素材 |

## 本地验证

先安装依赖并运行 `npm test`。测试使用合成消息，不需要 Bot 凭据。发布包安装建议用隔离的 DSH home 验证，避免与日常实例的 Bot 连接重叠。

```sh
npm ci --ignore-scripts
npm test
npm run pack:release
export DSH_HOME="$(mktemp -d)"
dsh plugin --profile web add ./maomao-dsh-panel-0.2.24.tgz
dsh --profile web --dump-config
dsh web --host 127.0.0.1
```

调整渠道和记忆时，优先测试错误 Bot、未授权会话、解绑后重试，以及不同群之间的隔离。改 UI 时同时验证空配置和已有绑定。新增渠道或模型可从现有连接器与适配器的结构开始。

## 发版

1. 更新 `package.json`、锁文件和 README 的版本。如果支持了新的 DSH 版本，实际安装验证后再改 `engines.dsh`。
2. 运行测试和打包，检查归档内容，再用空白 DSH profile 安装。
3. 将版本提交合入 `main`，再推送与包版本一致的 `vX.Y.Z` 标签。`Stage npm release` 会重新测试和打包，通过 GitHub Actions OIDC 将安装包提交到 npm 待发布队列。维护者在 npm 审核并完成二次验证后，用户才能安装这个版本。手动运行该工作流只会测试和打包。
4. 从该工作流下载 `maomao-npm-tarball`，将同一份 tgz 上传到 GitHub Release。

npm 上的 Trusted Publisher 对应仓库 `ififi2017/dsh-plugin-maomao` 和工作流 `npm-release.yml`，授权范围为暂存发布。发布任务使用 GitHub 托管运行器和短期 OIDC 凭据。[npm Trusted Publisher 文档](https://docs.npmjs.com/trusted-publishers/)

GitHub 仓库使用 `dsh-plugin` 主题。需要更新分享图时，在 Settings → General → Social preview 上传 `assets/github-og.png`，再检查仓库页面和安装链接。

供 GitHub 发现的 bundle 位于仓库根目录。源码已经是可运行的 JavaScript，仓库安装无需运行 prepare。参见 [DSH 官方仓库说明](https://github.com/deepseek-ai/deepseek-harness#community-and-support)和[bundle 发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
