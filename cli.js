#!/usr/bin/env node
'use strict';

const path = require('path');

if (!process.env.VGT_APP_ROOT) {
  process.env.VGT_APP_ROOT = __dirname;
}

const { main } = require(path.join(__dirname, 'core', 'cli'));

main(process.argv.slice(2), { appRoot: __dirname })
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  })
  .catch((err) => {
    process.stderr.write(`[错误] ${err?.message || err}\n`);
    process.exitCode = 1;
  });
