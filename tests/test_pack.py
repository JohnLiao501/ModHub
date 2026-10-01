"""在临时目录验证打包替换和本地版本保留，不接触真实发布目录。"""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pack


class PackTests(unittest.TestCase):
    def setUp(self):
        self.previous_cwd = Path.cwd()
        self.temporary = tempfile.TemporaryDirectory(prefix='modhub-pack-test-')
        self.root = Path(self.temporary.name).resolve()
        os.chdir(self.root)
        Path('src').mkdir()
        self.release = Path('release')
        self.release.mkdir()
        Path('src/main.js').write_text('// 测试运行资源\n', encoding='utf-8')
        Path('src/test-smart-sort.js').write_text('// 不应进入安装包\n', encoding='utf-8')
        Path('tests').mkdir()
        Path('tests/example.js').write_text('// 不应进入安装包\n', encoding='utf-8')
        self.write_boot('1.0.4')

    def tearDown(self):
        os.chdir(self.previous_cwd)
        self.temporary.cleanup()

    def write_boot(self, version, scripts=None):
        boot = {'name': 'ModHub', 'version': version, 'scriptFileList': scripts or ['main.js']}
        Path('src/boot.json').write_text(json.dumps(boot), encoding='utf-8')

    def old_packages(self, versions):
        for version in versions:
            (self.release / f'ModHub-v{version}.zip').write_bytes(f'旧包 {version}'.encode())

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.release.iterdir() if p.is_file()}

    def run_pack(self):
        with contextlib.redirect_stdout(io.StringIO()):
            pack.pack_mod()

    def test_replace_latest_and_keep_three(self):
        self.old_packages(['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4'])
        (self.release / 'ModHub-v1.0.4-archive2.zip').write_bytes(b'archive')
        for name in ['other.zip', 'ModHub-vnotes.zip']:
            (self.release / name).write_bytes(b'unrelated')
        self.run_pack()
        remaining = self.snapshot()
        self.assertEqual(set(remaining), {
            'ModHub-v1.0.2.zip', 'ModHub-v1.0.3.zip', 'ModHub-v1.0.4.zip',
            'other.zip', 'ModHub-vnotes.zip',
        })
        self.assertEqual(remaining['ModHub-v1.0.2.zip'], '旧包 1.0.2'.encode())
        self.assertEqual(remaining['ModHub-v1.0.3.zip'], '旧包 1.0.3'.encode())
        self.assertEqual(remaining['other.zip'], b'unrelated')
        self.assertEqual(remaining['ModHub-vnotes.zip'], b'unrelated')
        with zipfile.ZipFile(self.release / 'ModHub-v1.0.4.zip') as zf:
            self.assertIsNone(zf.testzip())
            self.assertEqual(set(zf.namelist()), {'boot.json', 'main.js'})
            self.assertEqual(zf.read('main.js'), Path('src/main.js').read_bytes())
            self.assertEqual(json.loads(zf.read('boot.json'))['version'], '1.0.4')
        self.assertEqual(json.loads(Path('src/boot.json').read_text())['version'], '1.0.4')

    def test_new_version_uses_numeric_order(self):
        self.old_packages(['1.0.6', '1.0.7', '1.0.8', '1.0.9'])
        self.write_boot('1.0.10')
        self.run_pack()
        self.assertEqual(set(self.snapshot()), {
            'ModHub-v1.0.8.zip', 'ModHub-v1.0.9.zip', 'ModHub-v1.0.10.zip',
        })

    def test_validation_failure_preserves_all_packages(self):
        self.old_packages(['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4'])
        before = self.snapshot()
        self.write_boot('1.0.4', ['missing.js'])
        with self.assertRaises(SystemExit):
            self.run_pack()
        self.assertEqual(self.snapshot(), before)

    def test_write_or_replace_failure_preserves_all_packages(self):
        self.old_packages(['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4'])
        before = self.snapshot()
        for operation in ['pack.zipfile.ZipFile.write', 'pack.os.replace']:
            with self.subTest(operation=operation):
                with patch(operation, side_effect=OSError('模拟磁盘写入失败')):
                    with self.assertRaises(OSError):
                        self.run_pack()
                self.assertEqual(self.snapshot(), before)

    def test_early_script_validation_preserves_formal_package(self):
        self.old_packages(['1.0.4'])
        before = self.snapshot()
        boot = json.loads(Path('src/boot.json').read_text())
        boot['scriptFileList_inject_early'] = ['early.js']
        Path('src/boot.json').write_text(json.dumps(boot), encoding='utf-8')
        with self.assertRaises(SystemExit):
            self.run_pack()
        self.assertEqual(self.snapshot(), before)
        Path('src/early.js').write_text('// 早期恢复入口\n', encoding='utf-8')
        self.run_pack()
        with zipfile.ZipFile(self.release / 'ModHub-v1.0.4.zip') as archive:
            self.assertIn('early.js', archive.namelist())

    def test_lower_or_invalid_version_is_rejected_before_writes(self):
        self.old_packages(['1.0.2', '1.0.3', '1.0.4'])
        before = self.snapshot()
        for version in ['1.0.3', '../1.0.4']:
            with self.subTest(version=version):
                self.write_boot(version)
                with self.assertRaises(SystemExit):
                    self.run_pack()
                self.assertEqual(self.snapshot(), before)

        # 最新版本即使只剩归档，也不能由较低源码版本覆盖过去。
        (self.release / 'ModHub-v1.0.5-archive1.zip').write_bytes(b'newer archive')
        before = self.snapshot()
        self.write_boot('1.0.4')
        with self.assertRaises(SystemExit):
            self.run_pack()
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
