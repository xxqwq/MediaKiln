'use strict';

(function () {
  window.VGT = window.VGT || {};

  const STORAGE_MIRROR = 'vgt_update_mirror';
  const STORAGE_AUTO_CHECK = 'vgt_auto_check';

  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function mirrorLabel(id) {
    if (id === 'official') return 'GitHub 直连';
    if (id === 'ghproxy') return 'gh-proxy 加速';
    if (id === 'ghfast') return 'ghfast 加速';
    return '自动择优';
  }

  function createUpdaterController({ toast, isRunning } = {}) {
    let status = null;
    let checkRes = null;
    let checking = false;
    let applying = false;
    let modalEl = null;

    const getMirrorPref = () => localStorage.getItem(STORAGE_MIRROR) || 'auto';
    const setMirrorPref = (v) => localStorage.setItem(STORAGE_MIRROR, v || 'auto');
    const getAutoCheck = () => localStorage.getItem(STORAGE_AUTO_CHECK) !== '0';
    const setAutoCheck = (v) => localStorage.setItem(STORAGE_AUTO_CHECK, v ? '1' : '0');

    function renderSidebarPill() {
      const btn = document.getElementById('btn-check-update');
      const label = document.getElementById('ver-label');
      const dot = document.getElementById('ver-dot');
      if (!btn || !label) return;

      const ver = status?.effectiveVersion ? `v${status.effectiveVersion}` : 'v—';
      const hasUpdate = checkRes && (checkRes.status === 'hotfix-available' || checkRes.status === 'shell-upgrade-required');
      const pendingReload = !!status?.pendingRestart;

      if (pendingReload) {
        label.textContent = `${ver} · 待刷新生效`;
      } else if (hasUpdate) {
        label.textContent = `${ver} · 发现 v${checkRes.manifest.version}`;
      } else if (status?.isHotfix) {
        label.textContent = `${ver} · 热更新`;
      } else {
        label.textContent = `${ver} · 测试版`;
      }

      if (dot) {
        dot.classList.toggle('hidden', !hasUpdate && !pendingReload);
      }
      btn.classList.toggle('has-update', Boolean(hasUpdate || pendingReload));
    }

    async function refreshStatus() {
      if (typeof window.api?.hotfixStatus !== 'function') return null;
      try {
        status = await window.api.hotfixStatus();
      } catch {
        status = null;
      }
      renderSidebarPill();
      return status;
    }

    async function checkNow({ silent = false } = {}) {
      if (checking || applying || typeof window.api?.hotfixCheck !== 'function') return null;
      checking = true;
      renderModalBody();
      try {
        const res = await window.api.hotfixCheck({ mirror: getMirrorPref() });
        if (res?.ok) {
          checkRes = res;
          if (res.current) status = res.current;
          renderSidebarPill();
          if (!silent && res.status === 'up-to-date') {
            toast?.('当前已是最新版本');
          } else if (res.status === 'hotfix-available' && silent) {
            toast?.(`发现热更新 v${res.manifest.version}（点击左下角版本标签查看）`);
          }
        } else if (!silent) {
          checkRes = { ok: false, error: res?.error || '检查更新失败' };
          toast?.(checkRes.error, true);
        }
        return checkRes;
      } catch (err) {
        if (!silent) {
          checkRes = { ok: false, error: err?.message || '检查更新失败' };
          toast?.(checkRes.error, true);
        }
        return null;
      } finally {
        checking = false;
        renderModalBody();
      }
    }

    async function applyHotfix() {
      if (applying || !checkRes?.manifest || typeof window.api?.hotfixApply !== 'function') return;
      applying = true;
      renderModalBody();
      setProgressUi(0, '正在连接更新源…');

      try {
        const res = await window.api.hotfixApply({
          manifest: checkRes.manifest,
          mirror: getMirrorPref(),
          preferredMirror: checkRes.mirror || '',
        });
        if (!res?.ok) {
          throw new Error(res?.error || '热更新安装失败');
        }
        if (res.status) status = res.status;
        renderSidebarPill();

        if (res.busy) {
          toast?.(`v${res.version} 已下载就绪，当前任务完成后可点击“立即刷新生效”`);
          applying = false;
          renderModalBody();
          return;
        }
        setProgressUi(1, `v${res.version} 校验通过，正在热重载…`);
        toast?.(`热更新 v${res.version} 已就绪，正在刷新界面…`);
      } catch (err) {
        applying = false;
        renderModalBody();
        toast?.(err?.message || '热更新失败', true);
      }
    }

    function setProgressUi(ratio, text) {
      if (!modalEl) return;
      const box = modalEl.querySelector('#upd-progress-box');
      const fill = modalEl.querySelector('#upd-progress-fill');
      const lbl = modalEl.querySelector('#upd-progress-text');
      if (box) box.classList.remove('hidden');
      if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100)}%`;
      if (lbl && text) lbl.textContent = text;
    }

    function closeModal() {
      if (modalEl) {
        modalEl.remove();
        modalEl = null;
      }
    }

    function renderModalBody() {
      if (!modalEl) return;
      const body = modalEl.querySelector('#upd-body');
      const foot = modalEl.querySelector('#upd-foot');
      if (!body || !foot) return;

      const curVer = status?.effectiveVersion ? `v${status.effectiveVersion}` : '未知';
      const builtinVer = status?.builtinVersion ? `v${status.builtinVersion}` : '未知';
      const shellVer = status?.shellVersion ? `v${status.shellVersion}` : '未知';
      const modeBadge = status?.isHotfix
        ? `<span class="upd-badge is-hotfix">热更新生效中（内置 ${escHtml(builtinVer)}）</span>`
        : `<span class="upd-badge">内置原版</span>`;

      let resultHtml = '';
      if (checking) {
        resultHtml = `<div class="upd-card muted">正在从 ${escHtml(mirrorLabel(getMirrorPref()))} 检查最新版本…</div>`;
      } else if (status?.pendingRestart) {
        resultHtml = `
          <div class="upd-card is-ready">
            <div class="upd-card-title">新版本 v${escHtml(status.activeVersion)} 已下载并校验通过</div>
            <div class="upd-card-sub">等当前处理任务结束后，点击下方“立即刷新生效”即可无损切换。</div>
          </div>
        `;
      } else if (checkRes?.ok && checkRes.status === 'hotfix-available') {
        const m = checkRes.manifest;
        resultHtml = `
          <div class="upd-card is-available">
            <div class="upd-card-head">
              <span class="upd-card-title">发现业务热更新 v${escHtml(m.version)}</span>
              <span class="upd-size">${escHtml(fmtSize(m.bundleSize))} · ${escHtml(mirrorLabel(checkRes.mirror))}</span>
            </div>
            <div class="upd-notes">${escHtml(m.notes || '包含功能优化与问题修复，无需重装完整客户端。')}</div>
            ${isRunning?.() ? '<div class="upd-warn">当前有任务正在运行，可先下载热更新包，任务结束后再一键刷新生效。</div>' : ''}
          </div>
        `;
      } else if (checkRes?.ok && checkRes.status === 'shell-upgrade-required') {
        const m = checkRes.manifest;
        resultHtml = `
          <div class="upd-card is-shell">
            <div class="upd-card-head">
              <span class="upd-card-title">发现大版本 v${escHtml(m.version)}</span>
              <span class="upd-badge is-warn">需升级安装包</span>
            </div>
            <div class="upd-notes">${escHtml(m.notes || `该版本要求主程序壳 >= v${m.minShellVersion}（当前 ${shellVer}），请下载最新安装版或便携版。`)}</div>
          </div>
        `;
      } else if (checkRes?.ok && checkRes.status === 'up-to-date') {
        resultHtml = `
          <div class="upd-card is-ok">
            <div class="upd-card-title">当前已是最新版本 (${escHtml(curVer)})</div>
            <div class="upd-card-sub">更新通道：${escHtml(mirrorLabel(checkRes.mirror))}</div>
          </div>
        `;
      } else if (checkRes?.ok && checkRes.status === 'skipped-bad') {
        resultHtml = `
          <div class="upd-card is-warn">
            <div class="upd-card-title">已跳过异常版本 v${escHtml(checkRes.manifest?.version)}</div>
            <div class="upd-card-sub">该版本上次加载异常已自动回滚，建议等待下一版本。</div>
          </div>
        `;
      } else if (checkRes && !checkRes.ok) {
        resultHtml = `
          <div class="upd-card is-err">
            <div class="upd-card-title">检查更新失败</div>
            <div class="upd-card-sub">${escHtml(checkRes.error || '请检查网络连接或切换下方镜像通道')}</div>
          </div>
        `;
      } else {
        resultHtml = `<div class="upd-card muted">点击下方“检查更新”，可秒级拉取仅几百 KB 的业务热更新包（便携版与安装版均适用）。</div>`;
      }

      body.innerHTML = `
        <div class="upd-meta-grid">
          <div><span class="muted">公开测试版</span><strong>${escHtml(curVer)}</strong> ${modeBadge}</div>
          <div><span class="muted">主程序壳</span><span>${escHtml(shellVer)}</span></div>
        </div>
        <div class="upd-prefs">
          <label class="upd-pref-row">
            <span>下载通道</span>
            <select id="upd-mirror-sel" ${applying ? 'disabled' : ''}>
              <option value="auto"${getMirrorPref() === 'auto' ? ' selected' : ''}>自动择优（推荐）</option>
              <option value="ghproxy"${getMirrorPref() === 'ghproxy' ? ' selected' : ''}>gh-proxy 国内加速</option>
              <option value="ghfast"${getMirrorPref() === 'ghfast' ? ' selected' : ''}>ghfast 国内加速</option>
              <option value="official"${getMirrorPref() === 'official' ? ' selected' : ''}>GitHub 官方直连</option>
            </select>
          </label>
          <label class="upd-check-row">
            <input type="checkbox" id="upd-auto-chk" ${getAutoCheck() ? 'checked' : ''} />
            <span>启动时静默检查更新</span>
          </label>
        </div>
        ${resultHtml}
        <div id="upd-progress-box" class="upd-progress-box ${applying ? '' : 'hidden'}">
          <div class="progress-track"><div id="upd-progress-fill" class="progress-fill"></div></div>
          <div id="upd-progress-text" class="muted progress-text">准备下载…</div>
        </div>
      `;

      body.querySelector('#upd-mirror-sel')?.addEventListener('change', (e) => setMirrorPref(e.target.value));
      body.querySelector('#upd-auto-chk')?.addEventListener('change', (e) => setAutoCheck(e.target.checked));

      const btns = [];
      btns.push(`<button type="button" class="btn btn-ghost btn-sm" id="upd-btn-check" ${checking || applying ? 'disabled' : ''}>${checking ? '检查中…' : '检查更新'}</button>`);

      if (status?.pendingRestart) {
        btns.push(`<button type="button" class="btn btn-primary btn-sm" id="upd-btn-reload">立即刷新生效</button>`);
      } else if (checkRes?.ok && checkRes.status === 'hotfix-available') {
        btns.push(`<button type="button" class="btn btn-primary btn-sm" id="upd-btn-apply" ${applying ? 'disabled' : ''}>${applying ? '正在更新…' : '⚡ 立即热更新'}</button>`);
      } else if (checkRes?.ok && checkRes.status === 'shell-upgrade-required') {
        btns.push(`<button type="button" class="btn btn-primary btn-sm" id="upd-btn-open-dl">前往下载完整版</button>`);
      }

      if (status?.isHotfix && !applying) {
        btns.push(`<button type="button" class="btn btn-ghost btn-sm" id="upd-btn-rollback" title="还原为安装包自带的内置代码">恢复内置版本</button>`);
      }
      btns.push(`<button type="button" class="btn btn-ghost btn-sm upd-foot-right" id="upd-btn-close" ${applying ? 'disabled' : ''}>关闭</button>`);
      foot.innerHTML = btns.join('');

      foot.querySelector('#upd-btn-check')?.addEventListener('click', () => checkNow({ silent: false }));
      foot.querySelector('#upd-btn-apply')?.addEventListener('click', () => applyHotfix());
      foot.querySelector('#upd-btn-reload')?.addEventListener('click', async () => {
        const r = await window.api?.hotfixReloadNow?.();
        if (r && !r.ok) toast?.(r.error || '刷新失败', true);
      });
      foot.querySelector('#upd-btn-open-dl')?.addEventListener('click', () => {
        const url = checkRes?.manifest?.fullReleaseUrl;
        if (url) window.api?.openExternal?.(url);
      });
      foot.querySelector('#upd-btn-rollback')?.addEventListener('click', async () => {
        const r = await window.api?.hotfixRollback?.();
        if (r && !r.ok) toast?.(r.error || '回滚失败', true);
      });
      foot.querySelector('#upd-btn-close')?.addEventListener('click', closeModal);
    }

    function openUpdateModal() {
      if (modalEl) return;
      modalEl = document.createElement('div');
      modalEl.className = 'wf-modal-overlay';
      modalEl.id = 'update-modal';
      modalEl.innerHTML = `
        <div class="wf-modal-dialog upd-dialog" role="dialog" aria-modal="true" aria-label="检查更新与热更新">
          <div class="wf-modal-head">
            <span class="wf-modal-title">⚡ 应用更新与热更新</span>
            <button type="button" class="wf-modal-close" id="upd-x-close" title="关闭">✕</button>
          </div>
          <div class="wf-modal-body" id="upd-body"></div>
          <div class="wf-modal-foot" id="upd-foot"></div>
        </div>
      `;
      document.body.appendChild(modalEl);
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl && !applying) closeModal();
      });
      modalEl.querySelector('#upd-x-close')?.addEventListener('click', () => {
        if (!applying) closeModal();
      });
      renderModalBody();
      if (!checkRes && !checking) {
        checkNow({ silent: false });
      }
    }

    async function init() {
      await refreshStatus();
      if (status?.rolledBackFrom) {
        toast?.(`热更新 v${status.rolledBackFrom} 启动异常，已自动回滚到稳定版本`, true);
      }
      document.getElementById('btn-check-update')?.addEventListener('click', openUpdateModal);

      window.api?.onHotfixProgress?.((p) => {
        if (!p) return;
        if (p.stage === 'downloading') {
          const pct = p.total > 0 ? `${Math.round((p.ratio || 0) * 100)}% (${fmtSize(p.received)} / ${fmtSize(p.total)})` : fmtSize(p.received);
          setProgressUi(p.ratio || 0.2, `正在下载热更新包 [${mirrorLabel(p.mirror)}]：${pct}`);
        } else if (p.stage === 'verifying') {
          setProgressUi(0.92, '正在校验 SHA-256 完整性…');
        } else if (p.stage === 'extracting') {
          setProgressUi(0.98, '正在解压并验证模块…');
        }
      });

      if (getAutoCheck() && typeof window.api?.hotfixCheck === 'function') {
        setTimeout(() => { checkNow({ silent: true }); }, 3500);
      }
    }

    return { init, openUpdateModal, checkNow, refreshStatus };
  }

  window.VGT.updater = { createUpdaterController };
})();
