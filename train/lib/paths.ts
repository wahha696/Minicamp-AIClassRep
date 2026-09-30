// train/ 的路径约定：从本文件位置反推 train/ 目录，再派生各生成物路径。
// 编译产物是 <root>/train/dist/train/lib/paths.js（上 3 级回到 train/）；
// 若将来直接以 tsx 跑源码则是 <root>/train/lib/paths.js（上 1 级）。
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const startDir = dirname(fileURLToPath(import.meta.url));

/** train/ 目录（编译产物 vs 源码直跑都成立） */
export const TRAIN_DIR = startDir.split(sep).includes('dist')
  ? dirname(dirname(dirname(startDir))) // dist/train/lib → train
  : dirname(startDir); // lib → train

/** 仓库根（train 的上一级） */
export const ROOT_DIR = dirname(TRAIN_DIR);
/** 生成物（不进 git） */
export const DATA_DIR = join(TRAIN_DIR, 'data');
export const MODELS_DIR = join(TRAIN_DIR, 'models');
export const ARTIFACTS_DIR = join(TRAIN_DIR, 'artifacts');
/** 合成剧本目录（训练专用，绝不指向 data/mock/） */
export const SCENARIO_DIR = join(DATA_DIR, 'scenarios');
