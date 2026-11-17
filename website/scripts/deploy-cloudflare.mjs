// 本地直接部署到 Cloudflare Pages（不依赖 GitHub，也不需要关联仓库）
// 用法：npm run deploy:cf            （首次会打开浏览器登录 Cloudflare）
// 可选环境变量：CF_PROJECT（项目名，默认 video-gif-toolbox）、SITE_URL（正式域名）
import { spawnSync } from 'node:child_process';

const project = process.env.CF_PROJECT || 'video-gif-toolbox';
const env = {
  ...process.env,
  BASE_PATH: '/',
  SITE_URL: process.env.SITE_URL || `https://${project}.pages.dev`,
};

const run = (cmd, args) => {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('npm', ['run', 'build']);
run('npx', ['--yes', 'wrangler@latest', 'pages', 'deploy', 'dist', '--project-name', project, '--branch', 'main', '--commit-dirty=true']);
