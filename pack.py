import os
import zipfile
import json

def pack_mod():
    src_dir = 'src'
    with open('src/boot.json', 'r', encoding='utf-8') as bf:
        boot = json.load(bf)
    version = boot['version']
    zip_name = f'ModHub-v{version}.zip'

    release_dir = os.path.abspath('release')
    os.makedirs(release_dir, exist_ok=True)

    release_target = os.path.join(release_dir, zip_name)
    if os.path.exists(release_target):
        raise SystemExit(f'拒绝覆盖已有归档，请保留历史版本：{release_target}')

    def should_exclude(rel_path):
        parts = rel_path.split('/')
        if any(p.startswith('.') for p in parts):
            return True
        if 'copy' in rel_path.lower():
            return True
        if rel_path == 'test-smart-sort.js':
            return True
        return False

    # 1. 直接打包生成至 release 归档目录
    expected_files = set()
    with zipfile.ZipFile(release_target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(src_dir):
            for f in files:
                full_path = os.path.join(root, f)
                rel_path = os.path.relpath(full_path, src_dir).replace('\\', '/')
                if should_exclude(rel_path):
                    continue
                expected_files.add(rel_path)
                if rel_path.endswith('.twee'):
                    with open(full_path, 'r', encoding='utf-8') as tf:
                        twee_content = tf.read().replace('\r\n', '\n')
                    zf.writestr(rel_path, twee_content.encode('utf-8'))
                else:
                    zf.write(full_path, arcname=rel_path)

    print(f'打包完成：{release_target}（{os.path.getsize(release_target)} 字节）')

    # 2. 校验包体完整性
    with zipfile.ZipFile(release_target, 'r') as zf:
        namelist = set(zf.namelist())
        if zf.testzip() is not None or 'boot.json' not in namelist:
            raise SystemExit('校验失败：压缩包损坏或根目录缺少 boot.json')
        if namelist != expected_files or len(namelist) != len(zf.namelist()):
            raise SystemExit('校验失败：包内清单与源码清单不一致，或存在重复条目')
        if any('\\' in name or name.startswith('/') or '..' in name.split('/') for name in namelist):
            raise SystemExit('校验失败：包内路径必须为安全的正斜杠相对路径')
        if json.loads(zf.read('boot.json'))['version'] != version:
            raise SystemExit('校验失败：包内版本与源码版本不一致')
        missing = []
        for k in ['styleFileList', 'scriptFileList', 'tweeFileList', 'imgFileList']:
            for path in boot.get(k, []):
                if path not in namelist:
                    missing.append((k, path))
                    
        for addon in boot.get('addonPlugin', []):
            params = addon.get('params', [])
            if isinstance(params, list):
                for p in params:
                    rf = p.get('replaceFile')
                    if rf and rf not in namelist:
                        missing.append(('replaceFile', rf))
                        
        if missing:
            print('校验失败：压缩包缺少声明文件：', missing)
            raise SystemExit(1)
        print('校验通过：包内版本、清单、文件完整性与正斜杠路径均正确')

    # 3. release 归档目录：历史版本永久保留，严禁自动清理（红线规约，见 AGENTS.md）
    # 注意：自 v1.0.1 起打包产物不再同步至游戏 MOD 文件夹，仅归档于 release/ 并通过 GitHub Releases 分发。
    for name in sorted(os.listdir(release_dir)):
        if name.startswith('ModHub-v') and name.endswith('.zip') and name != zip_name:
            print(f'保留历史归档：{name}')

    # 4. 清理项目根目录下散落的任何 zip 包体，确保"只保留在 release 文件夹"
    for name in os.listdir('.'):
        if name.startswith('ModHub-v') and name.endswith('.zip'):
            try:
                os.remove(name)
                print(f'已清理根目录散落包体：{name}')
            except Exception as e:
                print(f'清理 {name} 时出现警告：{e}')

if __name__ == '__main__':
    pack_mod()
