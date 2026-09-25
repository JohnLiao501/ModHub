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
    with zipfile.ZipFile(release_target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(src_dir):
            for f in files:
                full_path = os.path.join(root, f)
                rel_path = os.path.relpath(full_path, src_dir).replace('\\', '/')
                if should_exclude(rel_path):
                    continue
                zf.write(full_path, arcname=rel_path)

    print(f'Pack complete: {release_target} ({os.path.getsize(release_target)} bytes)')

    # 2. 校验包体完整性
    with zipfile.ZipFile(release_target, 'r') as zf:
        namelist = set(zf.namelist())
        if zf.testzip() is not None or 'boot.json' not in namelist:
            raise SystemExit('CRITICAL: Invalid zip or missing root boot.json')
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
            print('CRITICAL: Missing files in zip:', missing)
            raise SystemExit(1)
        print('VERIFIED: All boot.json assets correctly packed with forward slashes!')

    # 3. release 归档目录：历史版本永久保留，严禁自动清理（红线规约，见 AGENTS.md）
    # 注意：自 v1.0.1 起打包产物不再同步至游戏 MOD 文件夹，仅归档于 release/ 并通过 GitHub Releases 分发。
    for name in sorted(os.listdir(release_dir)):
        if name.startswith('ModHub-v') and name.endswith('.zip') and name != zip_name:
            print(f'Kept archived package in release: {name}')

    # 4. 清理项目根目录下散落的任何 zip 包体，确保"只保留在 release 文件夹"
    for name in os.listdir('.'):
        if name.startswith('ModHub-v') and name.endswith('.zip'):
            try:
                os.remove(name)
                print(f'Cleaned root stray zip: {name}')
            except Exception as e:
                print(f'Warning cleaning {name}: {e}')

if __name__ == '__main__':
    pack_mod()
