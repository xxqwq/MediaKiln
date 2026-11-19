'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_NAME = '.vgt-workflow-cache';
const OWNER_FILE = '.vgt-cache-owner';

function isOwnedDirectory(dir, owner) {
  try {
    const marker = path.join(dir, OWNER_FILE);
    return fs.lstatSync(dir).isDirectory()
      && fs.lstatSync(marker).isFile()
      && fs.readFileSync(marker, 'utf8') === owner;
  } catch {
    return false;
  }
}

function openCache(parent) {
  fs.mkdirSync(parent, { recursive: true });
  const root = path.join(fs.realpathSync(parent), CACHE_NAME);
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, OWNER_FILE), 'vgt-workflow-root-v1', { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  if (!isOwnedDirectory(root, 'vgt-workflow-root-v1') || fs.realpathSync(root) !== root) {
    throw new Error('无法使用此位置的缓存子目录，请选择其他位置');
  }
  return root;
}

function allocateNodeDir(root, key) {
  if (!isOwnedDirectory(root, 'vgt-workflow-root-v1') || fs.realpathSync(root) !== root) {
    throw new Error('工作流缓存目录已变更，请重新选择缓存位置');
  }
  const clean = String(key || 'node').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const dir = fs.mkdtempSync(path.join(root, `node_${clean}-`));
  fs.writeFileSync(path.join(dir, OWNER_FILE), 'vgt-workflow-node-v1', { flag: 'wx' });
  return dir;
}

function ownedNodeDirs(root) {
  if (!isOwnedDirectory(root, 'vgt-workflow-root-v1') || fs.realpathSync(root) !== root) {
    throw new Error('工作流缓存目录已变更，请重新选择缓存位置');
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((ent) => ent.isDirectory() && ent.name.startsWith('node_'))
    .map((ent) => path.join(root, ent.name))
    .filter((dir) => isOwnedDirectory(dir, 'vgt-workflow-node-v1') && fs.realpathSync(dir) === dir);
}

function removeNodeDir(root, dir) {
  if (path.dirname(dir) !== root || !isOwnedDirectory(root, 'vgt-workflow-root-v1')
    || fs.realpathSync(root) !== root || !isOwnedDirectory(dir, 'vgt-workflow-node-v1')
    || fs.realpathSync(dir) !== dir) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { openCache, allocateNodeDir, ownedNodeDirs, removeNodeDir };
