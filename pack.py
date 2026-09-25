import os
import zipfile
import shutil
import json
import filecmp

def pack_mod():
    src_dir = 'src'
    with open('src/boot.json', 'r', encoding='utf-8') as bf:
        boot = json.load(bf)
    version = boot['version']
    zip_name = f'ModHub-v{version}.zip'
    
    release_dir = os.path.abspath('release')
    mod_dir = os.path.abspath('../MOD')
    os.makedirs(release_dir, exist_ok=True)
    
    release_target = os.path.join(release_dir, zip_name)
    mod_target = os.path.join(mod_dir, zip_name)

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

    # 3. 同步至游戏 MOD 目录
    # 注意：游戏生效目录必须保持单一最新版。同名模组多版本并存会导致 ModLoader
    # 重复加载或版本冲突，因此 MOD 目录中的旧包仍需自动移除（此为例外，见下）。
    if os.path.exists(mod_dir):
        shutil.copy2(release_target, mod_target)
        if not filecmp.cmp(release_target, mod_target, shallow=False):
            raise SystemExit('CRITICAL: Copied package does not match source zip')
        print(f'Copied and verified: {mod_target}')
        for name in os.listdir(mod_dir):
            path = os.path.join(mod_dir, name)
            if name.startswith('ModHub-v') and name.endswith('.zip') and path != mod_target:
                os.remove(path)
                print(f'Removed old package in MOD: {path}')

    # 4. release 归档目录：历史版本永久保留，严禁自动清理（红线规约，见 AGENTS.md）
    for name in sorted(os.listdir(release_dir)):
        if name.startswith('ModHub-v') and name.endswith('.zip') and name != zip_name:
            print(f'Kept archived package in release: {name}')

    # 5. 清理项目根目录下散落的任何 zip 包体，确保"只保留在 release 和 MOD 文件夹"
    for name in os.listdir('.'):
        if name.startswith('ModHub-v') and name.endswith('.zip'):
            try:
                os.remove(name)
                print(f'Cleaned root stray zip: {name}')
            except Exception as e:
                print(f'Warning cleaning {name}: {e}')

if __name__ == '__main__':
    pack_mod()
