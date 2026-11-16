'use strict';

const runner = require('./core/runner');
const videoBuilders = require('./modules/video');
const imageBuilders = require('./modules/image');
const svgBuilders = require('./modules/svg');

const builders = {
  ...videoBuilders,
  ...imageBuilders,
  ...svgBuilders,
};

const executeTask = runner.createExecutor(builders);

module.exports = {
  probe: runner.probe,
  executeTask,
  cancelTask: runner.cancelTask,
  cancelAllTasks: runner.cancelAllTasks,
  hasRunningTasks: runner.hasRunningTasks,
  detectHwEncoders: runner.detectHwEncoders,
  FFMPEG: runner.FFMPEG,
};
