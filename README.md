# ModHub

Degrees of Lewdity (DoL) 模组管理套件，基于 ModLoader 2.x 运行时与 TweeReplacer 补丁架构。

## 主要功能

1. **模组管理**：支持旁加载模组的启用、禁用、删除、拖拽排序与智能依赖拓扑排序。
2. **模组市场**：整合社区模组源与 GitHub Release，支持国内高速下载通道与断点/故障自动切换。
3. **ReadMe 浏览器**：支持离线与在线双源 Markdown 文档渲染阅读。
4. **加载日志**：提供结构化错误分析、关键词过滤及诊断长图生成导出。

## 目录与工具分工

- `src/`：ModHub 模组核心源码（`boot.json`、`javascript/`、`stylesheet/`、`twee/`）。
- `release/`：由 `pack.py` 打包生成的安装包（`ModHub-v<version>.zip`）；游戏中的实时调试生效副本位于同级 `../MOD/`。
- `dolmod-site/`：模组市场在线索引、身份目录与反馈中心 Worker/Pages 仓库。
- `mod-identities.json`：模组市场元数据与统一身份字典。
- `dol-mod-extractor.js`：DoL 中文 Wiki 模组列表抓取、解析与身份合并脚本。
- `test-dol-mod-extractor.js`：模组身份字典与提取器的自动化校验脚本。
- `plans/`：ModHub 功能规划、版本迭代案与验收记录。

## 验证与打包

- 核心单元测试（含依赖拓扑排序与 ModLoader 契约）：`node src/test-smart-sort.js`
- 模组身份字典测试：`node test-dol-mod-extractor.js`
- 自动化打包与双目录归档：`python pack.py`
