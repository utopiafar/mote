import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
const root = resolve('../..');
const vendor = join(root, 'vendor/llama.cpp');
const revision = spawnSync('git', ['-C', vendor, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (revision.status !== 0 || revision.stdout.trim() !== '1744c6bde8d687ce9774b3b54e688eee0bfdf5b7') throw new Error('请先运行根目录 npm run models:setup 获取固定 llama.cpp 源码版本');
if (spawnSync('git', ['-C', vendor, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()) throw new Error('固定 llama.cpp 源码含本地改动，请先恢复或另行保存');
let cmake = process.env.MOTE_CMAKE || 'cmake';
if (spawnSync(cmake, ['--version'], { stdio: 'ignore' }).status !== 0) {
  const fallback = join(homedir(), 'Library/Android/sdk/cmake/3.22.1/bin/cmake');
  if (!existsSync(fallback)) throw new Error('请安装 CMake 3.22+，或通过 MOTE_CMAKE 指定可执行文件');
  cmake = fallback;
}
const ninja = process.env.MOTE_NINJA || join(dirname(cmake), 'ninja');
const args = ['-S', 'native/qwen', '-B', 'native/bin/qwen-build', '-DMOTE_LLAMA_ROOT=' + vendor, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3'];
if (existsSync(ninja)) args.push('-G', 'Ninja', '-DCMAKE_MAKE_PROGRAM=' + ninja);
for (const command of [args, ['--build', 'native/bin/qwen-build', '--target', 'mote-qwen', '-j', process.env.MOTE_BUILD_JOBS || '4']]) {
  const result = spawnSync(cmake, command, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
copyFileSync('native/bin/qwen-build/mote-qwen', 'native/bin/mote-qwen');
