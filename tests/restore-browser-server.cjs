// 隔离浏览器验收服务：真实游戏只在内存加工，测试包不落盘。
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const args = process.argv.slice(2);
const gameArg = args.indexOf('--game');
if (gameArg >= 0 && (!args[gameArg + 1] || args[gameArg + 1].startsWith('--'))) throw new Error('--game 后须提供游戏 HTML 路径');
const gamePath = gameArg < 0 ? path.resolve(root, '..', 'DoL-ModLoader-0.5.12.13-v2.101.1', 'Degrees of Lewdity.html') : path.resolve(args[gameArg + 1]);
const portArg = args.indexOf('--port');
const port = portArg < 0 ? 0 : Number(args[portArg + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口应为 0 至 65535 的整数');
const namespaceArg = args.indexOf('--namespace');
const namespace = namespaceArg < 0 ? 'modhub_acceptance_v120' : args[namespaceArg + 1];
if (!/^modhub_acceptance_[a-z0-9_]+$/.test(namespace)) throw new Error('隔离名称必须使用 modhub_acceptance_ 前缀与小写字母、数字或下划线');
const boot = JSON.parse(fs.readFileSync(path.join(src, 'boot.json'), 'utf8'));
const packageScript = String.raw`
import sys,json,io,zipfile,pathlib,struct,zlib
p=json.load(sys.stdin); output=io.BytesIO()
def png(rgb):
 def chunk(t,b): return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+bytes(rgb)*2)*2))+chunk(b'IEND',b'')
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 def add(n,b):
  item=zipfile.ZipInfo(n,(2026,1,1,0,0,0)); item.compress_type=zipfile.ZIP_DEFLATED; z.writestr(item,b)
 if p['kind']=='current':
  source=pathlib.Path(p['src'])
  for f in sorted(source.rglob('*')):
   if not f.is_file(): continue
   n=f.relative_to(source).as_posix()
   if any(x.startswith('.') for x in n.split('/')) or 'copy' in n.lower() or n=='test-smart-sort.js': continue
   add(n,f.read_text(encoding='utf-8').replace('\r\n','\n').encode() if n.endswith('.twee') else f.read_bytes())
 else:
  kind=p['kind']; name={'base':'ModHub验收图包','base-b':'ModHub验收图包乙','updated':'ModHub验收图包','throw':'ModHub验收抛错','hang':'ModHub验收挂起'}[kind]
  b={'name':name,'version':'2.0.0' if kind=='updated' else '1.0.0','description':'仅限独立本机验收页面','styleFileList':[],'scriptFileList':[],'tweeFileList':[],'imgFileList':[],'dependenceInfo':[{'modName':'ModHub','version':'^'+p['version']}]}
  if kind in ['base','base-b','updated']:
   b['addonPlugin']=[{'modName':'BeautySelectorAddon','addonName':'BeautySelectorAddon','modVersion':'^2.9.0','params':{'type':'ModHub验收美化乙' if kind=='base-b' else 'ModHub验收美化甲','imgFileList':['img/modhub-test.png']}}]
   b['dependenceInfo'].append({'modName':'BeautySelectorAddon','version':'^2.9.0'})
   add('img/modhub-test.png',png([70,100,90] if kind=='base-b' else [110,100,80] if kind=='base' else [70,90,110]))
  else:
   b['scriptFileList_earlyload']=['javascript/modhub-acceptance.js']
   add('javascript/modhub-acceptance.js', ('(() => { throw new Error("[ModHub] 隔离验收用启动错误"); })()' if kind=='throw' else 'new Promise(() => {})').encode())
  add('boot.json',json.dumps(b,ensure_ascii=False).encode())
sys.stdout.buffer.write(output.getvalue())
`;
function python(script, input) {
    const result = spawnSync('python', ['-c', script], { input, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.toString('utf8'));
    return result.stdout;
}
const packages = new Map(['base', 'base-b', 'updated', 'throw', 'hang'].map(kind => [kind,
    python(packageScript, JSON.stringify({ src, kind, version: boot.version }))]));
const packageHashes = Object.fromEntries([...packages].map(([kind, data]) => [kind, crypto.createHash('sha256').update(data).digest('hex')]));
const readHtml = () => fs.readFileSync(path.join(__dirname, 'restore-browser.html'), 'utf8');
const readDriver = () => {
    const driver = readHtml().match(/<script id="modHubAcceptanceDriver">([\s\S]*?)<\/script>/)?.[1];
    if (!driver) throw new Error('验收页面缺少测试驱动');
    return driver;
};
readDriver();
const original = fs.readFileSync(gamePath, 'utf8');
const gameVersion = original.match(/\b(?:const|let|var)\s+StartConfig\s*=\s*\{[^}]*\bversion\s*:\s*["']([^"']+)["']/)?.[1];
if (!gameVersion) throw new Error('游戏 HTML 中未找到 StartConfig.version，无法核验验收基线');
const embedded = /window\.modDataValueZipList\s*=\s*\[[\s\S]*?\];/;
if (!embedded.test(original)) throw new Error('真实游戏中未找到内嵌模组入口，已停止加工');
function gamePassage(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = original.match(new RegExp(`<tw-passagedata[^>]*name="${escaped}"[^>]*>([\\s\\S]*?)</tw-passagedata>`));
    if (!match) throw new Error(`游戏中未找到补丁目标段落：${name}`);
    const entities = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
    return match[1].replace(/&(?:lt|gt|quot|#39|amp);/g, entity => entities[entity]);
}
function verifyGameCompatibility() {
    const patches = boot.addonPlugin.find(plugin => plugin.modName === 'TweeReplacer').params;
    for (const patch of patches) {
        const content = gamePassage(patch.passage);
        const count = patch.findString ? content.split(patch.findString).length - 1 : [...content.matchAll(new RegExp(patch.findRegex, patch.regexFlag))].length;
        if (count !== 1) throw new Error(`DoL ${gameVersion} 的 ${patch.passage} 补丁匹配 ${count} 处，应唯一匹配`);
    }
    const overlay = gamePassage('overlayReplace');
    for (const widget of ['setupTabs', 'toggleTab', 'closeButtonMobile', 'closeButton']) {
        if (!overlay.includes(`<<widget "${widget}">>`)) throw new Error(`DoL ${gameVersion} 缺少原生界面组件：${widget}`);
    }
    for (const id of ['customOverlay', 'customOverlayTitle', 'customOverlayContent']) {
        if (!original.includes(`id="${id}"`)) throw new Error(`DoL ${gameVersion} 缺少原生界面容器：${id}`);
    }
    for (const variable of ['--000', '--600', '--850', '--gold', '--red']) {
        if (!new RegExp(`${variable}\\s*:`).test(original)) throw new Error(`DoL ${gameVersion} 缺少原生调色变量：${variable}`);
    }
    return patches.length;
}
function configuration(mode) {
    const prefix = `${namespace}_${mode}`;
    const keys = {
        ModLoader_IndexDBLoader: `${prefix}_mods`,
        modDataIndexDBZipList: `${prefix}_enabled`,
        modDataIndexDBZipListHidden: `${prefix}_disabled`,
        modDataIndexDBZip: `${prefix}_zip`,
        modDataLocalStorageZipList: `${prefix}_local_enabled`,
        modDataLocalStorageZip: `${prefix}_local_zip`,
        BeautySelectorAddon: `${prefix}_beauty`,
        BeautySelectorAddon_OrderSaveKey: `${prefix}_beauty_order`,
        BeautySelectorAddon_dbNameCacheFileList: `${prefix}_beauty_files`,
        BeautySelectorAddon_dbNameImageStore: `${prefix}_beauty_images`,
    };
    return { mode, prefix, keys, hashes: packageHashes, version: boot.version };
}
function head(mode) {
    return `<script>window.modHubAcceptanceConfig=${JSON.stringify(configuration(mode))};window.modLoaderKeyConfigWinHookFunction=function(config){for(const [key,value] of Object.entries(window.modHubAcceptanceConfig.keys))config.config.set(key,value);};</script><script src="/acceptance.js"></script>`;
}
function currentGame() {
    // 核心开发并行进行时，每次打开游戏都注入当时的源码，不要求重启服务。
    const current = python(packageScript, JSON.stringify({ src, kind: 'current', version: JSON.parse(fs.readFileSync(path.join(src, 'boot.json'), 'utf8')).version }));
    packages.set('current', current);
    packageHashes.current = crypto.createHash('sha256').update(current).digest('hex');
    return original.replace(/<head(?:\s[^>]*)?>/i, match => match + head('game'))
        .replace(embedded, match => match + `\nwindow.modDataValueZipList.push(${JSON.stringify(current.toString('base64'))});`);
}
const currentHarness = () => {
    const currentBoot = JSON.parse(fs.readFileSync(path.join(src, 'boot.json'), 'utf8'));
    const styles = currentBoot.styleFileList.map(file => `<link rel="stylesheet" href="/source/${file}">`).join('');
    return readHtml().replace('<head>', '<head>' + styles + head('harness')).replace(/<script id="modHubAcceptanceDriver">[\s\S]*?<\/script>/, '');
};
function send(res, status, type, data) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
}
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/game') return send(res, 200, 'text/html; charset=utf-8', currentGame());
        if (req.method === 'GET' && ['/', '/harness'].includes(url.pathname)) return send(res, 200, 'text/html; charset=utf-8', currentHarness());
        if (req.method === 'GET' && url.pathname === '/acceptance.js') return send(res, 200, 'text/javascript; charset=utf-8', readDriver());
        if (req.method === 'GET' && url.pathname === '/api/package') {
            const data = packages.get(url.searchParams.get('kind'));
            if (!data) return send(res, 400, 'text/plain; charset=utf-8', '未知测试包');
            return send(res, 200, 'application/zip', data);
        }
        if (req.method === 'POST' && url.pathname === '/api/inspect') {
            const parts = []; let size = 0;
            for await (const part of req) { size += part.length; if (size > 8 * 1024 * 1024) throw new Error('验收包超过限定大小'); parts.push(part); }
            const result = python('import sys,zipfile,io,json\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.testzip() is None\nsys.stdout.buffer.write(json.dumps(json.loads(z.read("boot.json")),ensure_ascii=False).encode())', Buffer.concat(parts));
            return send(res, 200, 'application/json; charset=utf-8', result);
        }
        if (req.method === 'GET' && url.pathname.startsWith('/source/')) {
            const relative = decodeURIComponent(url.pathname.slice('/source/'.length));
            const target = path.resolve(src, relative);
            if (!target.startsWith(src + path.sep) || !fs.statSync(target).isFile()) return send(res, 404, 'text/plain; charset=utf-8', '源码路径不存在');
            return send(res, 200, target.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', fs.readFileSync(target));
        }
        if (url.pathname === '/modlist.json') return send(res, 200, 'application/json', '[]');
        return send(res, 404, 'text/plain; charset=utf-8', '验收资源不存在');
    } catch (error) { send(res, 500, 'text/plain; charset=utf-8', `验收服务错误：${error.message}`); }
});
if (args.includes('--self-test')) {
    const patchCount = verifyGameCompatibility();
    const game = currentGame();
    if (!game.includes(packages.get('current').toString('base64')) || !game.includes(configuration('game').keys.ModLoader_IndexDBLoader)) throw new Error('内存注入校验失败');
    console.log(`DoL ${gameVersion} 静态兼容核验通过：${patchCount} 个入口补丁均唯一匹配，原生组件、容器及调色变量齐全。`);
    console.log(`验收游戏：${gamePath}`);
    console.log(`内存注入校验通过：真实游戏 ${Buffer.byteLength(original)} 字节，当前包 ${packages.get('current').length} 字节，当前包与 ${packages.size - 1} 个测试包均未落盘。此检查不代表完整游戏运行验收。`);
} else {
    server.listen(port, '127.0.0.1', () => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        console.log(`ModHub ${boot.version} 隔离验收服务已启动，仅监听本机。`);
        console.log(`验收游戏：DoL ${gameVersion}，${gamePath}`);
        console.log(`原生存储验收：${origin}/harness`);
        console.log(`真实游戏验收：${origin}/game`);
        console.log(`测试库前缀：${namespace}_。停止服务请按 Ctrl+C。`);
    });
}
