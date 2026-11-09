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
dsh plugin --profile web add ./maomao-dsh-panel-0.2.23.tgz
dsh --profile web --dump-config
dsh web --host 127.0.0.1
```

调整渠道和记忆时，优先测试错误 Bot、未授权会话、解绑后重试，以及不同群之间的隔离。改 UI 时同时验证空配置和已有绑定。新增渠道或模型可从现有连接器与适配器的结构开始。

## 发版

1. 更新 `package.json`、锁文件和 README 的版本。如果支持了新的 DSH 版本，实际安装验证后再改 `engines.dsh`。
2. 运行测试和打包，检查归档内容，再用空白 DSH profile 安装。
3. 为提交创建与包版本一致的 `vX.Y.Z` 标签，把 `npm run pack:release` 生成的 tgz 上传到 GitHub Release。
4. 在 GitHub 仓库添加 `dsh-plugin` 主题。在 Settings → General → Social preview 上传 `assets/github-og.png`。更新后用仓库页面和实际安装链接验证。

供 GitHub 发现的 bundle 位于仓库根目录。源码已经是可运行的 JavaScript，仓库安装无需运行 prepare。参见 [DSH 官方仓库说明](https://github.com/deepseek-ai/deepseek-harness#community-and-support)和[bundle 发布指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
