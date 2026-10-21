# DoLP 兼容性核验

核验日期：2026-10-21。ModHub 源码版本：1.8.1。

## 适配行为

- 将 `0.5.12.11 DoLP v0.778` 识别为 DoL 基线 `0.5.12.11`、DoLP 分支和 DoLP 版本 `0.778`，保留原始版本文本。
- 选版与安装确认同时显示 DoLP 版本及 DoL 基线；市场检查缓存和风险确认按完整游戏身份隔离。
- 普通 DoL 的版本范围或文件名不能证明 DoLP 兼容。未核验的分支保留手动选择和具体提示，不自动推荐或默认选择。
- 明确标注 DoLP 且基线吻合的文件名仅作为参考，不视为作者声明或游戏实测证据；普通 DoL 不自动选择 DoLP 包。
- 下载后的真实包体继续核对。未声明游戏范围的包也不能跳过 DoLP 分支确认；未知不等于不兼容。

本次未调整在线索引结构、游戏原生 `GameVersion` 常量或加载器版本比较规则。

## 官方测试输入

截至核验时，[Frostberg 官方最新发布](https://gitgud.io/Frostberg/degrees-of-lewdity-plus/-/releases/v0.778)为 v0.778，发布时间为 2026-09-10。游戏实际标识为 `0.5.12.11 DoLP v0.778`。

| 附件 | 字节数 | 本地计算的 SHA-256 |
| --- | ---: | --- |
| [DoLP_HTML_only_v0.778.zip](https://dolp.download/DoLP_HTML_only/v0.778/DoLP_HTML_only_v0.778.zip) | 9762503 | `b3c063f159473c361e553fc7497607dc1f5541084eb0bca55ea6b59d9488cfc9` |
| [DoLP_Vanilla_v0.778.zip](https://dolp.download/DoLP_Vanilla/v0.778/DoLP_Vanilla_v0.778.zip) | 71770013 | `7a1d9632717d4928aabcc0568b7e42f76c525cc0397ee3388e13ea10c4c20f30` |

两份 ZIP 均通过完整 CRC 检查。摘要用于复现本次输入，不冒充作者公布的认证摘要。

官方原生包不含 ModLoader 或 TweeReplacer。真实运行测试使用官方 HTML、同版 Vanilla 图像及从[汉化官方发布 v0.5.12.13-chs-1.0.1a](https://github.com/Eltirosto/Degrees-of-Lewdity-Chinese-Localization/releases/tag/v0.5.12.13-chs-1.0.1a)提取的真实加载器组件，在隔离副本中按加载器原有启动挂钩注入：

| 组件 | 测试版本 |
| --- | --- |
| ModLoader | 2.101.1 |
| ModLoaderGui | 1.9.1 |
| ConflictChecker | 1.3.0 |
| TweeReplacerLinker | 1.0.0 |
| TweeReplacer | 1.7.0 |
| I18nTweeReplacer | 1.1.0 |
| ModHub | 核验时的 1.8.1 开发快照 |

此表记录测试组合，不代表全部组件都是 ModHub 的新增前置。ModHub 的前置清单仍以 `src/boot.json` 为准。ModHub 测试 ZIP 仅在内存中构造，未覆盖正式归档；测试页面内的 41 份包内资源已与核验时的源码逐字节核对一致，不代表后续发布包已完成全量游戏实测。

## 核验结果

| 检查 | 结果 |
| --- | --- |
| `overlayReplace`、`Widgets Clothing Caption`、`StoryCaption` 原始锚点 | 每处唯一命中，无需修改现有补丁 |
| 实际 TweeReplacer 应用 | 3 处成功，0 处补丁错误 |
| 真实侧栏入口 | 正常通过游戏年龄确认后，可点击 ModHub 并打开管理页 |
| 加载器仓库 | 真实 `customStore`、`calcModNameKey`、两份启禁列表键及原生包校验接口均可用 |
| 真实还原 | A/B 基线建点后升级 A、新增 C、改变启禁与顺序；确认还原并自动重载后，包体 SHA-256、两份列表及顺序精确恢复，C 移除，恢复记录清空 |
| 重载及成功通知 | 重载后的实际运行包 A/B 均为 1.0.0；就绪后显示成功通知，关闭后通知记录原子清除 |
| 运行界面 | 360px 与 1280px 已检查；最终真实游戏页面异常和原生警告框均为 0 |
| 自动化回归 | `node src/test-smart-sort.js` 全部通过，修改文件 Emoji 扫描为 0 |
| 下载任务入口 | 360/768/1440px 共 12 个状态场景通过，含实际颜色、触控尺寸、展开和 Escape 返回焦点 |

恢复验证使用新浏览器上下文、隔离来源和无脚本测试包。未替换真实 IndexedDB、事务或加载器包体校验接口，未访问或更改玩家已有游戏及存档。

证据保留在本地隔离测试记录中，不随源码或安装包分发。主要文件为 `official-release.json`、`package-evidence.json`、`static-evidence.json`、`dolp-runtime-assets.json`、`dolp-runtime-build.json` 与 `dolp-runtime-browser.json`，另保留下载按钮截图与验证脚本。

最终汇总为 `dolp-runtime-final-summary.json`，包含源码一致性、真实重载、还原步骤及异常记录；完整自动化日志为 `regression.log`。真实运行页面异常、原生警告框及加载器错误均为 0，控制台剩余信息为官方 CSP 阻止联网与对应离线回退。

## 验证边界

官方原生 DoLP HTML 的 CSP 为 `default-src 'self' 'unsafe-eval' 'unsafe-inline'`，会阻止访问外部市场接口。本次测试保留此策略，未放宽网络权限；本机加载器版 DoL 的策略与其不同。2026-10-21 按用户决定停止 CSP 放宽与 DoLP 在线市场适配，保留已完成的版本识别、本地管理及还原支持。未生成放宽 CSP 的游戏副本，不宣称在线市场或生产发布已验收。

本次通过的是上述明确组合中的启动、管理入口和模组还原场景，不是完整剧情、美化库或任意第三方模组组合的兼容证明。其他 DoLP 汉化版、整合包和加载器版本仍需分别核验。

本兼容性核验阶段未升级源码版本、生成正式安装包、提交、推送或发布；后续正式包及发布状态以 GitHub Release 和交付回执为准。
