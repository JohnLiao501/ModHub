// ModHub 核心单元测试
// 覆盖契约：boot.json 版本与清单、ModLoader v2.101.1+ 兼容层、智能依赖拓扑排序、
// 单/多模组导入分流、ModLoadController 持久化、模组禁用/启用切换、模组删除、
// 拖拽重排逻辑、原生模态框状态判定、统一索引契约（网站 <-> Mod 端同源消费）。

let suiteComplete = false;
process.on('beforeExit', () => {
    if (!suiteComplete) {
        console.error('测试未完成：存在未结束的异步用例');
        process.exitCode = 1;
    }
});

(async () => {
    await require('../tests/manager.test')();
    await require('../tests/restore.test')();
    await require('../tests/restore-panel.test')();
    await require('../tests/restore-startup.test')();
    await require('../tests/market-catalog.test')();
    await require('../tests/diagnostics-conflicts.test')();
    await require('../tests/market-install.test')();
    await require('../tests/market-versions.test')();
    await require('../tests/market-preparation.test')();
    await require('../tests/market-version-install.test')();
    await require('../tests/interaction.test')();

    suiteComplete = true;
    console.log('ModHub v1.3.2 全部测试通过');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
