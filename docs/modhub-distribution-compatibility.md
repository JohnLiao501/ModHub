# 整合包、内容分支与美化兼容性

调查日期：2026-11-01。本文件记录公开源码证据与本轮适配范围，不代表完整游戏或任意模组组合已经实测。

## 支持矩阵

| 环境 | 可核验依据 | 本轮处理与边界 |
| --- | --- | --- |
| DoL 原版及汉化加载器版 | 游戏自身版本；加载器与前置以 `src/boot.json` 为准 | 沿用现有管理与选版逻辑；汉化版本不能代替 DoL 基线版本 |
| DoLP | 例如 `0.5.12.11 DoLP v0.778` | 保留 DoL 基线和 DoLP 版本；DoL 兼容声明不能直接证明 DoLP 兼容；此前的限定组合验证见 [DoLP 核验记录](modhub-dolp-compatibility.md) |
| Lyra 系整合包 | 已加载模组的真实 `boot.json.name` 精确为 `Lyra` | 额外标记整合环境，保留游戏内容分支和信息包版本；不把来自 DoLP 的图片认作 DoLP 内容分支；基线吻合仍需核对整合兼容性 |
| XFox / DOL-X 等保留 Lyra 信息包的衍生整合 | 作者构建代码仍生成 `name: Lyra` 的信息包 | 纳入 Lyra 系整合提示；该标识不能证明来自上游 Lyra，也不能单独识别为 XFox；XFox 与下行 DoLX 是不同项目 |
| X-Change / DoLX | 作者仓库 `version` 文件显示 `0.5.12.13 DoLP v0.778 DoLX 0.22.3` | 解析 DoL 基线、DoLP 父分支版本和 DoLX 版本；DoL 或 DoLP 说明不能直接证明 DoLX 兼容；未完整识别的版本保留未知状态 |
| 其他整合包和分支 | 见下方公开入口 | 尚未取得可靠运行时标识，不单独识别；加载器可用时沿用通用能力，仍须人工核对组合 |

识别读取当前游戏与真实模组资料，不修改游戏原生版本、第三方包名或作者兼容声明。文件名只能作为选版参考，不能代替真实包体校验及用户确认。

## 静态美化与 BeautySelectorAddon

Lyra 构建配置将 BESC、Hikari、Goose、UCB 等图片资源复制到游戏图片目录。这类静态资源没有独立的 BeautySelectorAddon（BSA）注册项，不能在 ModHub 中伪造为可启禁、排序的美化包。切换这部分图片需要使用对应整合包或原作者提供的资源方式。

AU 等通过 ModLoader 注入的模型，以及其他真实注册到 BSA 的图像包，仍按实际注册项管理。

Lyra 系环境中若存在已启用的 `GameOriginalImagePack`，ModHub 提示其可能覆盖整合包内置图片，并说明可在模组管理中禁用后重新载入；提示不会自动禁用、删除或重排任何模组。缺少 BSA 时仍显示整合来源说明，不声称可以管理未注册的静态图片。

内置模组在 ModHub 中仍为只读项，需要通过发行包提供的原生管理器处理；原生管理器也不支持禁用时，需使用不含该图像包的整合版本。整合包的完整游戏 ZIP 不能当作 ModLoader 模组导入。

## 公开证据与入口

- [Lyra 发布及构建仓库](https://github.com/DoL-Lyra/Lyra)：基于汉化发行基包制作整合，不是 DoL 或汉化组官方渠道。
- [Lyra 构建配置](https://github.com/DoL-Lyra/Lyra/blob/vega/config/build.toml)：`imagepacks` 指向 DoLP 图片资源，AU 经 `modloader_mods` 注入；两种资源方式不能混为一类。
- [Lyra 功能组合](https://github.com/DoL-Lyra/Lyra/blob/vega/config/features.toml)：记录 BESC、Goose、AU 的互斥，以及 Hikari、UCB 对 BESC 的依赖。
- [Lyra 信息包生成代码](https://github.com/DoL-Lyra/Lyra/blob/vega/lyra/lyra_mod.py)：生成精确名称 `Lyra`，版本可附组合后缀；该包本身只含版本和资源说明。
- [XFox 构建配置](https://github.com/XFoxLG/DOL-X/blob/vega/config/build.toml)及[信息包代码](https://github.com/XFoxLG/DOL-X/blob/vega/lyra/lyra_mod.py)：XFox 身份用于产物文件名及 APK，信息包仍保留 Lyra 名称；[作者说明](https://github.com/XFoxLG/DOL-X#疑难解答)记录原版图像包可能覆盖内置图片。
- [X-Change 作者仓库](https://gitgud.io/Akoz/dol-xchange/-/tree/master)：公开 `version` 文件采用 DoL、DoLP、DoLX 三层版本格式。此次未直接取得当前 `StartConfig.version` 原文，解析不构成完整运行证明。
- [DOL CHS Chemistry](https://github.com/WinterLa/DOL-CHS-Chemistry)：公开说明包含 BEC、TC、PB、G25、MEOW 等组合及旁加载入口，但说明与源码不足以确认当前发行的加载器和组合行为。
- [DoL-SHEL](https://github.com/PjShelter/DoL-SHEL)：Lyra 衍生仓库；未核验独立运行时标识，不能仅凭仓库名增加自动识别。
- [Transmod 作者仓库](https://gitgud.io/FadedLines/degrees-of-lewdity/-/tree/transmod)、[New World 源码入口](https://gitgud.io/Wub/degrees-of-lewdity-new-world)与[Bunny TF 作者源码入口](https://gitgud.io/WinterPeach/DOL-BUNNY)：与普通图片包分开看待；本轮未取得足以自动判定当前环境的完整运行时证据。

## 验证范围

`node src/test-smart-sort.js` 完整回归已通过，实际退出码为 0；修改文件的 Python Unicode 扫描为 0 Emoji，`git diff --check` 通过。本轮整合适配沿用工作区既有的 1.9.2；以上验证不含安装包或远端部署核验。

静态核验输入为 [Lyra 作者在线版](https://dol-lyra.github.io/dol.html)，本地读取 81,384,059 字节，SHA-256 为 `dc9ba7f31e60447f163e50de337b4c0da5c8b589430efe4b5b28a14929fff648`。其中 DoL 为 `0.5.11.9`，ModLoader 为 `2.101.1`，Lyra 信息包为 `0.5.11.9-1.0.0a-0815-besc`。当前三个入口补丁的段落和锚点均唯一命中，无需修改入口补丁。

浏览器使用该真实 HTML 与内存注入的当前 ModHub 源码，在隔离来源和浏览器上下文运行。会话未提供 Browser 插件，使用已安装的 Playwright。运行时回读为 `dol / 0.5.11.9 / lyra`，ModHub 入口存在；通过隔离控制台在年龄声明内挂载原生覆盖层，再点击管理页签并展开美化。真实语言控件的繁体中文、英语和简体中文切换均更新说明，360、768、1440px 下美化区均无横向溢出。未勾选年龄声明或进入剧情，未使用玩家已有存档，临时服务均已关闭。

离线重放缺少外部资源并阻断市场网络，存在资源 404、天气渲染错误，以及一条启动完成标记写入锁告警；不能称为完整游戏零错误。实际美化图像、AU 切换、市场下载安装和完整启动尚未验证。当前作者输入未启用原版图像包，覆盖警示由单元测试覆盖。

本文未把公开文档、单元测试或模拟页面称作完整游戏实测；跨整合存档、任意第三方组合及未列出的发行版仍属验证边界。没有核验过的第三方组合不得标记为兼容。
