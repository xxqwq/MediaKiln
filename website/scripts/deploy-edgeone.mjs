// 本地直接部署到腾讯云 EdgeOne Pages（不依赖 GitHub，也不需要关联仓库）
// 用法：npm run deploy:eo            （首次会自动打开浏览器登录腾讯云中国站）
// 可选环境变量：EO_PROJECT（项目名，默认 video-gif-toolbox）、SITE_URL（正式域名，如 https://tools.example.com）
import { spawnSync } from 'node:child_process';

const project = process.env.EO_PROJECT || 'video-gif-toolbox';
const area = process.env.EO_AREA || 'global';
const env = {
  ...process.env,
  BASE_PATH: '/',
  ...(process.env.SITE_URL ? { SITE_URL: process.env.SITE_URL } : {}),
};

const run = (cmd, args, { allowFail = false } = {}) => {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (!allowFail && r.status !== 0) process.exit(r.status ?? 1);
  return r.status === 0;
};

// 先检查 EdgeOne CLI 登录状态，未登录时引导登录腾讯云中国站
const authed = spawnSync('npx', ['--yes', 'edgeone@latest', 'whoami', '--json'], {
  stdio: 'ignore',
  env,
  shell: process.platform === 'win32',
}).status === 0;

if (!authed) {
  console.log('检测到尚未登录腾讯云 EdgeOne，即将打开浏览器进行授权登录…');
  run('npx', ['--yes', 'edgeone@latest', 'login', '--site', 'china']);
}

run('npx', ['--yes', 'edgeone@latest', 'pages', 'deploy', '-n', project, '-a', area]);
