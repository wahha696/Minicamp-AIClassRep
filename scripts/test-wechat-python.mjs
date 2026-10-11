import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const python = process.env.WECHAT4_TEST_PYTHON || join(root, 'classrep-fastjudge', process.platform === 'win32' ? 'py/python.exe' : '.venv/bin/python');
if (!existsSync(python)) throw new Error('Run node scripts/fastjudge-setup.mjs first');
const directory = join(root, 'tools/wechat4-read-probe');
const code = 'import sys,unittest;sys.path.insert(0,sys.argv[1]);r=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.discover(sys.argv[1]));sys.exit(not r.wasSuccessful())';
const result = spawnSync(resolve(python), ['-I', '-X', 'utf8', '-B', '-c', code, directory], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
process.exitCode = result.status ?? 1;
