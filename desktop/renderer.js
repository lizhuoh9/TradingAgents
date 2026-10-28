const $ = id => document.getElementById(id);
const pageNames = { analysis: '新建分析', watchlist: '我的自选', holdings: '我的持仓', reader: '报告阅读', markets: '市场与代码', settings: 'API 设置' };
let profileState = { profiles: [], selectedId: null };
let profileLoadError = '';
let editingId = null;
let reportRequest = 0;
let readRequest = 0;
let reportsCache = [];
let reportStockNames = new Map();
let reportNameWarning = '';
let selectedReportId = null;
const reportGroupsOpen = new Map();
let latestReportId = null;
let analysisBusy = false;
let operationBusy = false;
let batchBusy = false;
let updateState = { checkedAt: null, kernel: { status: 'unknown' }, ui: { status: 'unknown' } };
let updateCheckPromise = null;
let updateInstalling = '';
let uiReloadPending = false;
let watchlist = [];
let watchRevision = 0;
const watchResults = new Map();
let catalogRequest = 0;
let catalogTimer;
let catalogInFlight = false;
let queuedCatalogRequest = null;
let connectionRevision = 0;
let connectionTestInFlight = false;
const unreadableProfile = error => /无法解密|连接文件格式无效/.test(error.message);
function showProfileRecovery(show) {
  $('recover-profiles').hidden = !show;
  $('recover-profiles-inline').hidden = !show;
}

function showPage(name) {
  if (!pageNames[name]) return;
  document.querySelectorAll('[data-view]').forEach(view => { view.hidden = view.dataset.view !== name; });
  document.querySelectorAll('.navigation [data-page]').forEach(button => {
    button.classList.toggle('active', button.dataset.page === name);
    if (button.dataset.page === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('page-title').textContent = pageNames[name];
  window.scrollTo(0, 0);
  if (name === 'analysis' && followLog) {
    $('log').scrollTop = $('log').scrollHeight;
    lastLogScrollTop = $('log').scrollTop;
  }
  if (name === 'reader') loadReports();
  if (name === 'watchlist') { refreshWatchlist(); syncWatchProfiles(); }
  if (name === 'holdings') refreshHoldings();
}
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));

$('sidebar-toggle').addEventListener('click', () => {
  const collapsed = document.querySelector('.app-shell').classList.toggle('sidebar-collapsed');
  $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('sidebar-toggle').setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  $('sidebar-toggle').title = collapsed ? '展开侧栏' : '收起侧栏';
});

let followLog = true;
let lastLogScrollTop = 0;
function setLogFollow(enabled) {
  followLog = enabled;
  $('log-follow').setAttribute('aria-pressed', String(enabled));
  $('log-follow').title = enabled ? '自动滚动到最新日志' : '已暂停跟随，点击查看最新日志';
  if (enabled) $('log').scrollTop = $('log').scrollHeight;
  lastLogScrollTop = $('log').scrollTop;
}
$('log-follow').addEventListener('click', () => setLogFollow(!followLog));
$('log-wrap').addEventListener('click', () => {
  const nowrap = $('log').classList.toggle('log-nowrap');
  $('log-wrap').setAttribute('aria-pressed', String(!nowrap));
  if (followLog) $('log').scrollTop = $('log').scrollHeight;
  lastLogScrollTop = $('log').scrollTop;
});
$('log').addEventListener('scroll', () => {
  const log = $('log');
  if (log.offsetParent && log.scrollTop < lastLogScrollTop && log.scrollHeight - log.scrollTop - log.clientHeight > 48) setLogFollow(false);
  lastLogScrollTop = log.scrollTop;
});

$('date').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
window.desktop.onLog(text => {
  const log = $('log');
  log.textContent = (log.textContent + text).slice(-500000);
  if (followLog) log.scrollTop = log.scrollHeight;
  lastLogScrollTop = log.scrollTop;
});
window.desktop.onStopError(message => {
  if (!analysisBusy) return;
  $('status').textContent = '停止失败，请重试';
  document.querySelector('.status-pill').dataset.state = 'error';
  $('log').textContent = ($('log').textContent + '\n停止失败：' + message).slice(-500000);
  showTaskError('停止请求未完成', '任务可能仍在运行，可以再次尝试停止或等待其结束。');
  $('stop-run').disabled = false;
  if (batchBusy) { $('watch-message').textContent = '停止失败，请重试：' + message; $('watch-stop').disabled = false; }
});
function showTaskError(title, message) {
  $('home-error-title').textContent = title;
  $('home-error-message').textContent = message;
  $('home-error').hidden = false;
}
async function task(fn, message, canStop = false) {
  if (operationBusy) return;
  operationBusy = true;
  let finalState = 'idle';
  let errorTitle = '任务未完成';
  let errorMessage = '请查看日志了解原因，已保存的文件不会被删除。';
  $('home-error').hidden = true;
  analysisBusy = canStop;
  $('run').disabled = true;
  renderUpdateState();
  renderWatchlist();
  $('open-latest').hidden = true;
  latestReportId = null;
  $('log').textContent = '';
  lastLogScrollTop = 0;
  $('status').textContent = message;
  $('stop-run').hidden = !canStop;
  $('stop-run').disabled = false;
  document.querySelector('.status-pill').dataset.state = 'busy';
  try {
    const result = await fn();
    if (result && typeof result === 'object' && 'code' in result) {
      latestReportId = result.reportId || null;
      finalState = result.stopped ? 'stopped' : result.code !== 0 || !latestReportId ? 'error' : 'complete';
      if (result.code === 0 && !latestReportId && !result.stopped) { errorTitle = '未找到本次报告'; errorMessage = '分析已结束，但没有找到完整报告。请查看日志了解原因。'; }
      $('status').textContent = result.stopped ? '分析已停止' : result.code !== 0 ? '运行失败，退出码 ' + result.code : latestReportId ? '分析结束，报告已保存' : '分析结束，但未找到报告，请检查日志';
      $('open-latest').hidden = result.stopped || result.code !== 0 || !latestReportId;
    } else {
      finalState = typeof result === 'number' && result !== 0 ? 'error' : 'complete';
      $('status').textContent = typeof result === 'number' ? (result === 0 ? '任务结束，请检查日志和报告' : '运行失败，退出码 ' + result) : result;
    }
  } catch (error) {
    finalState = 'error';
    $('status').textContent = '失败';
    $('log').textContent += '\n' + error.message;
  } finally {
    analysisBusy = false;
    operationBusy = false;
    $('run').disabled = false;
    renderUpdateState();
    $('stop-run').hidden = true;
    $('stop-run').disabled = false;
    document.querySelector('.status-pill').dataset.state = finalState;
    if (finalState === 'error') showTaskError(errorTitle, errorMessage);
    else $('home-error').hidden = true;
    renderWatchlist();
  }
}
$('analysis-form').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
});
$('analysis-form').addEventListener('submit', event => {
  event.preventDefault();
  if (event.isComposing) return;
  const ticker = $('ticker').value.trim();
  if (/^\d{6}$/.test(ticker)) {
    const example = /^(60|68)/.test(ticker) ? `${ticker}.SS` : /^(00|30)/.test(ticker) ? `${ticker}.SZ` : `${ticker}.SS 或 ${ticker}.SZ`;
    showTaskError('请补充股票市场后缀', `六位数字代码需要注明交易所，例如 ${example}。请确认市场后再开始分析。`);
    $('ticker-hint').textContent = `请确认交易所并补充后缀，例如 ${example}`;
    $('ticker').focus();
    return;
  }
  if (!$('active-profile').value) { showPage('settings'); $('settings-message').textContent = profileLoadError || '请先添加并保存模型连接。'; return; }
  const date = $('date').value;
  task(async () => {
    const result = await window.desktop.run({ ticker, date, profileId: $('active-profile').value });
    const completed = result && !result.stopped && result.code === 0 && result.reportId;
    if (completed) await updateWatchProgress({ ticker: ticker.toUpperCase(), status: 'completed', reportId: result.reportId, date });
    return result;
  }, '分析中…', true);
});
$('ticker').addEventListener('input', () => { $('ticker-hint').textContent = '例如 NVDA、600172.SS、000001.SZ、0700.HK'; });
function renderUpdateState() {
  const available = ['kernel', 'ui'].some(target => updateState[target]?.available);
  $('update-dot').hidden = !available;
  $('update').setAttribute('aria-label', available ? '更新（有新版本）' : '更新');
  $('update').title = available ? '有新版本可更新' : '检查内核与界面更新';
  const busy = operationBusy || batchBusy || !!updateInstalling;
  const labels = { unknown: '未检查', current: '已是最新', available: '有新版本', error: '检查失败', blocked: '暂不能更新' };
  for (const target of ['kernel', 'ui']) {
    const state = updateState[target] || { status: 'unknown' };
    $(`${target}-update-current`).textContent = state.current || '—';
    $(`${target}-update-latest`).textContent = state.latest || '—';
    const status = $(`${target}-update-status`);
    status.textContent = updateInstalling === target ? '正在安装…' : labels[state.status] || '未检查';
    status.dataset.state = state.status;
    const error = $(`${target}-update-error`);
    error.textContent = state.error || '';
    error.hidden = !state.error;
    $(`update-${target}`).disabled = busy || state.status === 'blocked' || (target === 'ui' && (!state.available || uiReloadPending)) || typeof window.desktop.update !== 'function';
  }
  $('check-updates').disabled = !!updateCheckPromise || !!updateInstalling || typeof window.desktop.checkUpdates !== 'function';
  $('check-updates').textContent = updateCheckPromise ? '正在检查…' : '检查更新';
  $('updates-busy').hidden = !busy;
  $('updates-busy').textContent = updateInstalling ? `正在更新${updateInstalling === 'kernel' ? '官方内核' : '界面'}，详细进度可在运行日志中查看。` : '任务运行中，结束后可安装更新。';
  $('ui-reload-notice').hidden = !uiReloadPending;
  $('reload-ui').disabled = busy || typeof window.desktop.reloadUi !== 'function';
  const checkedAt = updateState.checkedAt ? new Date(updateState.checkedAt) : null;
  $('updates-checked').textContent = checkedAt && !Number.isNaN(checkedAt.valueOf()) ? `上次检查 ${checkedAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '尚未检查版本';
}
function checkUpdates(force = false) {
  if (updateCheckPromise) return updateCheckPromise;
  if (typeof window.desktop.checkUpdates !== 'function') {
    $('updates-message').textContent = '版本检查暂不可用，请重启桌面程序。';
    renderUpdateState();
    return Promise.resolve();
  }
  updateCheckPromise = Promise.resolve().then(() => window.desktop.checkUpdates(force)).then(state => {
    updateState = state;
  }).catch(error => {
    for (const target of ['kernel', 'ui']) updateState[target] = { ...updateState[target], status: 'error', error: error.message || '无法检查版本，请稍后重试。' };
  }).finally(() => { updateCheckPromise = null; renderUpdateState(); });
  renderUpdateState();
  return updateCheckPromise;
}
$('update').addEventListener('click', () => {
  renderUpdateState();
  if (!$('updates-dialog').open) $('updates-dialog').showModal();
  checkUpdates();
});
$('updates-close').addEventListener('click', () => $('updates-dialog').close());
$('updates-dialog').addEventListener('close', () => $('update').focus());
$('check-updates').addEventListener('click', () => checkUpdates(true));
async function installUpdate(target) {
  if (operationBusy || batchBusy || updateInstalling || $(`update-${target}`).disabled) return;
  updateInstalling = target;
  $('updates-message').textContent = '';
  let installed = false;
  showPage('analysis');
  await task(async () => {
    try {
      const message = await window.desktop.update(target);
      installed = true;
      return message;
    } catch (error) { $('updates-message').textContent = '更新未完成：' + error.message; throw error; }
  }, `正在更新${target === 'kernel' ? '官方内核' : '界面'}…`);
  updateInstalling = '';
  if (installed) {
    if (target === 'ui') uiReloadPending = true;
    $('updates-message').textContent = target === 'ui' ? '界面更新已安装，重新加载后生效。' : '官方内核更新完成。';
    if (updateCheckPromise) await updateCheckPromise;
    await checkUpdates(true);
  }
  renderUpdateState();
}
$('update-kernel').addEventListener('click', () => installUpdate('kernel'));
$('update-ui').addEventListener('click', () => installUpdate('ui'));
$('reload-ui').addEventListener('click', async () => {
  if (operationBusy || batchBusy || updateInstalling || !uiReloadPending) return;
  $('reload-ui').disabled = true;
  try { await window.desktop.reloadUi(); }
  catch (error) { $('updates-message').textContent = '重新加载失败：' + error.message; }
  finally { renderUpdateState(); }
});
if (window.desktop.onUpdatesChanged) window.desktop.onUpdatesChanged(state => { updateState = state; renderUpdateState(); });
if (window.desktop.checkUpdates) {
  checkUpdates();
  setInterval(() => { if (!updateInstalling) checkUpdates(); }, 6 * 60 * 60 * 1000);
}
$('stop-run').addEventListener('click', async () => {
  $('stop-run').disabled = true;
  try {
    const result = await window.desktop.stop();
    if (result.requested && analysisBusy) {
      $('status').textContent = '正在停止…';
      document.querySelector('.status-pill').dataset.state = 'busy';
      $('home-error').hidden = true;
    }
  } catch (error) {
    if (analysisBusy) { $('status').textContent = '停止失败，请重试'; document.querySelector('.status-pill').dataset.state = 'error'; showTaskError('停止请求未完成', '任务可能仍在运行，可以再次尝试停止或等待其结束。'); }
    $('log').textContent += '\n停止失败：' + error.message;
  } finally { if (analysisBusy) $('stop-run').disabled = false; }
});
document.querySelectorAll('[data-ticker]').forEach(button => button.addEventListener('click', () => { $('ticker').value = button.dataset.ticker; $('ticker').focus(); }));

function renderProfiles(state) {
  profileState = state;
  const select = $('active-profile');
  select.replaceChildren();
  if (!state.profiles.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = profileLoadError ? '无法读取已保存的连接，请查看 API 设置' : '请先在 API 设置中添加连接'; select.append(option);
  }
  for (const profile of state.profiles) {
    const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.model ? `${profile.name} · ${profile.model}` : profile.name; select.append(option);
  }
  select.value = state.selectedId || '';
  syncWatchProfiles();
  const list = $('profiles-list'); list.replaceChildren();
  $('profiles-status').textContent = profileLoadError || (state.profiles.length ? '选择连接以查看或编辑。' : '尚未添加模型连接。');
  for (const profile of state.profiles) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'profile-item';
    if (editingId === profile.id) button.classList.add('selected');
    const name = document.createElement('strong'); name.textContent = profile.name;
    const meta = document.createElement('small'); meta.textContent = profile.model + (profile.id === state.selectedId ? ' · 当前使用' : '');
    button.append(name, meta); button.addEventListener('click', () => editProfile(profile.id)); list.append(button);
  }
}
async function loadProfiles() {
  try { profileLoadError = ''; renderProfiles(await window.desktop.profiles()); showProfileRecovery(false); return true; }
  catch (error) {
    profileLoadError = '读取连接失败：' + error.message;
    $('profiles-status').textContent = profileLoadError;
    showProfileRecovery(unreadableProfile(error));
    const option = document.createElement('option'); option.value = ''; option.textContent = '无法读取已保存的连接，请查看 API 设置';
    $('active-profile').replaceChildren(option);
    return false;
  }
}
async function recoverProfiles() {
  if (!window.confirm('将无法读取的旧连接配置备份到本机，再保存当前连接？旧连接和密钥不会自动恢复。')) return;
  $('recover-profiles').disabled = $('recover-profiles-inline').disabled = true;
  try {
    const backup = await window.desktop.backupUnreadableProfiles();
    if (!await loadProfiles()) { $('settings-message').textContent = '原配置已备份到：' + backup + '。当前仍无法读取连接，请检查系统加密服务。'; return; }
    editingId = null;
    $('profile-heading').textContent = '新建连接';
    $('delete-profile').hidden = true;
    $('profile-key-hint').textContent = '密钥由 Windows 加密保存；本地无密钥服务可留空。';
    $('settings-message').textContent = '旧配置已备份到：' + backup + '。请检查当前连接和密钥，然后点击保存连接。';
  } catch (error) { $('settings-message').textContent = '备份失败：' + error.message; }
  finally { $('recover-profiles').disabled = $('recover-profiles-inline').disabled = false; }
}
$('recover-profiles').addEventListener('click', recoverProfiles);
$('recover-profiles-inline').addEventListener('click', recoverProfiles);
function toggleProvider() {
  const custom = $('profile-kind').value === 'advanced';
  $('provider-code-label').hidden = !custom;
  $('profile-provider').required = custom;
  $('profile-url').required = !custom;
  $('profile-url-hint').textContent = custom ? '可留空以使用默认地址；不要在地址中填写密钥。' : '请填写接口地址；不要在地址中填写密钥。';
}
$('profile-kind').addEventListener('change', () => { invalidateConnectionTest(); toggleProvider(); scheduleModelCatalog(); });
$('profile-provider').addEventListener('input', () => { invalidateConnectionTest(); scheduleModelCatalog(); });
$('profile-url').addEventListener('input', () => { invalidateConnectionTest(); scheduleModelCatalog(); });
$('profile-key').addEventListener('input', invalidateConnectionTest);
$('model-refresh').addEventListener('click', () => { invalidateConnectionTest(); scheduleModelCatalog(0); });
$('profile-model-choice').addEventListener('change', event => {
  if (event.target.value) $('profile-model').value = event.target.value;
  else $('profile-model').focus();
});
$('profile-model').addEventListener('input', syncModelChoice);

function syncModelChoice() {
  const choice = $('profile-model-choice');
  const id = $('profile-model').value.trim();
  choice.value = Array.from(choice.options).some(option => option.value === id) ? id : '';
}

function replaceModelOptions(models) {
  const choice = $('profile-model-choice');
  choice.replaceChildren();
  const custom = document.createElement('option'); custom.value = ''; custom.textContent = '手动填写其他模型 ID'; choice.append(custom);
  const seen = new Set();
  for (const model of (Array.isArray(models) ? models.slice(0, 2000) : [])) {
    if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    const option = document.createElement('option'); option.value = model.id;
    option.textContent = model.label && model.label !== model.id ? `${model.label}（${model.id}）` : model.id;
    choice.append(option);
  }
  choice.disabled = false;
  syncModelChoice();
  return seen.size;
}

function invalidateConnectionTest() {
  connectionRevision++;
  const status = $('model-fetch-status');
  status.dataset.state = '';
  status.textContent = connectionTestInFlight ? '连接信息或目录已改变，先前测试结果不会应用。' : '';
}

function connectionErrorMessage(error) {
  const text = String(error?.message || '');
  const reasons = [
    '密钥无效或无访问权限', '该地址没有模型列表接口', '服务返回了重定向', '连接超时',
    '服务没有返回兼容的模型列表', '模型列表过大', '服务返回的模型列表不是有效 JSON',
    '服务类型或地址已改变', '此服务类型暂不支持自动获取模型', '请先填写 API 地址',
    '请输入有效的 API 地址', 'API 地址必须为 HTTPS 或本机 HTTP', 'API 地址不能包含密钥',
    '配置已变更，请重新测试连接', '分析或更新进行中，请稍后测试连接',
  ];
  const match = reasons.find(reason => text.includes(reason));
  return match ? `连接失败：${match}。` : '连接失败；请检查服务地址、密钥和网络。';
}

$('model-fetch').addEventListener('click', async () => {
  const revision = ++connectionRevision;
  const catalog = catalogRequest;
  connectionTestInFlight = true;
  $('model-fetch').disabled = true;
  $('model-fetch-status').dataset.state = '';
  $('model-fetch-status').textContent = '正在连接所选服务…';
  try {
    const provider = $('profile-kind').value === 'advanced' ? $('profile-provider').value.trim().toLowerCase() : 'openai_compatible';
    const result = await window.desktop.fetchModels({ provider, baseUrl: $('profile-url').value.trim(), key: $('profile-key').value, profileId: editingId || undefined });
    if (revision !== connectionRevision || catalog !== catalogRequest) return;
    const models = Array.isArray(result.models) ? result.models : [];
    if (models.length) {
      catalogRequest++;
      clearTimeout(catalogTimer);
      const count = replaceModelOptions(models);
      $('model-catalog-status').textContent = '显示服务实时返回的模型；也可手动填写其他 ID。';
      $('model-fetch-status').textContent = `连接成功，显示 ${count} 个模型${models.length > count ? '（列表较长，未全部显示）' : ''}。`;
    } else {
      $('model-fetch-status').textContent = '连接成功，但服务未返回模型；可使用本地目录或手动填写。';
    }
  } catch (error) {
    if (revision !== connectionRevision || catalog !== catalogRequest) return;
    $('model-fetch-status').dataset.state = 'error';
    $('model-fetch-status').textContent = connectionErrorMessage(error) + ' 已保留本地目录。';
  } finally {
    connectionTestInFlight = false;
    $('model-fetch').disabled = false;
  }
});

function scheduleModelCatalog(delay = 300) {
  const request = ++catalogRequest;
  clearTimeout(catalogTimer);
  $('profile-model-choice').disabled = true;
  $('model-catalog-status').textContent = '正在读取本机模型目录…';
  catalogTimer = setTimeout(() => loadModelCatalog(request), delay);
}

async function loadModelCatalog(request) {
  if (request !== catalogRequest) return;
  if (catalogInFlight) { queuedCatalogRequest = request; return; }
  catalogInFlight = true;
  const provider = $('profile-kind').value === 'advanced' ? $('profile-provider').value.trim().toLowerCase() : 'openai_compatible';
  try {
    if (typeof window.desktop.listModels !== 'function') throw new Error('目录功能不可用，请更新桌面程序');
    const result = await window.desktop.listModels({ provider, baseUrl: $('profile-url').value.trim() });
    if (request !== catalogRequest) return;
    const count = replaceModelOptions(result.models);
    const detected = provider === 'openai_compatible' && result.detectedProvider && result.detectedProvider !== provider;
    const note = result.message || (count ? '显示本机官方模型目录，不代表账号权限；也可手动填写其他 ID。' : '未找到此服务的本地模型目录，可手动填写模型 ID。');
    $('model-catalog-status').textContent = detected ? `已识别官方服务，分析时使用其官方适配方式。${note}` : note;
    syncModelChoice();
  } catch (error) {
    if (request !== catalogRequest) return;
    const choice = $('profile-model-choice');
    choice.replaceChildren();
    const custom = document.createElement('option'); custom.value = ''; custom.textContent = '手动填写模型 ID'; choice.append(custom);
    choice.disabled = false;
    $('model-catalog-status').textContent = '无法读取模型目录，可手动填写模型 ID。';
  } finally {
    catalogInFlight = false;
    const next = queuedCatalogRequest;
    queuedCatalogRequest = null;
    if (next === catalogRequest) loadModelCatalog(next);
  }
}
function editProfile(id) {
  invalidateConnectionTest();
  const profile = profileState.profiles.find(item => item.id === id);
  editingId = profile ? id : null;
  $('profile-heading').textContent = profile ? '编辑连接' : '新建连接';
  $('profile-name').value = profile?.name || '';
  $('profile-kind').value = profile && profile.provider !== 'openai_compatible' ? 'advanced' : 'openai_compatible';
  $('profile-provider').value = profile && profile.provider !== 'openai_compatible' ? profile.provider : '';
  $('profile-model').value = profile?.model || '';
  $('profile-url').value = profile?.baseUrl || '';
  $('profile-key').value = '';
  $('profile-key-hint').textContent = profile?.hasKey ? '已保存密钥；留空将保留原密钥。' : '密钥由 Windows 加密保存；本地无密钥服务可留空。';
  $('delete-profile').hidden = !profile;
  $('settings-message').textContent = '';
  toggleProvider(); renderProfiles(profileState); scheduleModelCatalog();
}
$('new-profile').addEventListener('click', () => { editProfile(null); $('profile-name').focus(); });
$('active-profile').addEventListener('change', async event => {
  try { renderProfiles(await window.desktop.selectProfile(event.target.value)); }
  catch (error) { $('status').textContent = '切换失败：' + error.message; renderProfiles(profileState); }
});
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.isComposing) return;
  const data = { id: editingId || undefined, name: $('profile-name').value.trim(), provider: $('profile-kind').value === 'advanced' ? $('profile-provider').value.trim() : 'openai_compatible', model: $('profile-model').value.trim(), baseUrl: $('profile-url').value.trim(), key: $('profile-key').value };
  const previous = profileState.profiles.find(profile => profile.id === editingId);
  if (previous?.hasKey && !data.key && (previous.provider !== data.provider || (previous.baseUrl || '') !== data.baseUrl)) {
    $('settings-message').textContent = '更改服务类型或接口地址时，请重新输入密钥。';
    $('profile-key').focus();
    return;
  }
  $('save-profile').disabled = true; $('settings-message').textContent = '正在保存…';
  try {
    const state = await window.desktop.saveProfile(data);
    renderProfiles(state); editProfile(state.selectedId); $('settings-message').textContent = '连接已保存。';
  } catch (error) {
    if (unreadableProfile(error)) {
      showProfileRecovery(true);
      $('settings-message').textContent = '旧连接配置无法读取，暂时不能保存。可先备份旧配置，再保存当前连接。';
    } else $('settings-message').textContent = '保存失败：' + error.message;
  }
  finally { $('save-profile').disabled = false; }
});
$('profile-form').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault(); });
function showFredStatus(status) {
  $('fred-hint').textContent = status.hasKey ? '已保存密钥；留空将保留原密钥。' : '未配置时宏观数据不可用；可以留空。';
  $('fred-delete').hidden = !status.hasKey;
  $('fred-recover').hidden = true;
}
function showFredError(prefix, error) {
  $('fred-status').textContent = prefix + error.message;
  $('fred-recover').hidden = !/无法解密已保存的数据服务密钥|已保存的数据服务密钥格式无效/.test(error.message);
}
async function loadFredStatus() {
  if (!window.desktop.fredStatus) return;
  try { showFredStatus(await window.desktop.fredStatus()); }
  catch (error) { showFredError('读取数据服务配置失败：', error); }
}
$('fred-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('fred-save').disabled = true;
  try { showFredStatus(await window.desktop.saveFredKey($('fred-key').value)); $('fred-key').value = ''; $('fred-status').textContent = '数据服务设置已保存。'; }
  catch (error) { showFredError('保存失败：', error); }
  finally { $('fred-save').disabled = false; }
});
$('fred-delete').addEventListener('click', async () => {
  if (!window.confirm('删除本机保存的 FRED 密钥？')) return;
  try { showFredStatus(await window.desktop.deleteFredKey()); $('fred-key').value = ''; $('fred-status').textContent = '密钥已删除。'; }
  catch (error) { $('fred-status').textContent = '删除失败：' + error.message; }
});
$('fred-recover').addEventListener('click', async () => {
  if (!window.confirm('将无法读取的 FRED 密钥文件备份到本机？旧密钥不会自动恢复。备份后可重新输入密钥，也可暂不配置继续分析。')) return;
  $('fred-recover').disabled = true;
  try {
    const backup = await window.desktop.backupUnreadableFredKey();
    showFredStatus({ hasKey: false });
    $('fred-status').textContent = '旧密钥文件已备份到：' + backup + '。可重新保存密钥，或暂不配置继续分析。';
  } catch (error) { showFredError('备份失败：', error); }
  finally { $('fred-recover').disabled = false; }
});
$('delete-profile').addEventListener('click', async () => {
  if (!editingId || !window.confirm('确定删除此连接及其保存的密钥吗？')) return;
  try { const state = await window.desktop.deleteProfile(editingId); editingId = null; renderProfiles(state); editProfile(null); $('settings-message').textContent = '连接已删除。'; }
  catch (error) { $('settings-message').textContent = '删除失败：' + error.message; }
});

async function loadReports() {
  const request = ++reportRequest;
  $('reports-status').textContent = '正在读取…';
  try {
    const [reports, names] = await Promise.all([
      window.desktop.reportsList(),
      window.desktop.watchlist ? window.desktop.watchlist().then(items => ({ items })).catch(() => ({ items: [], failed: true })) : { items: [] },
    ]);
    if (request !== reportRequest) return;
    reportsCache = reports;
    reportStockNames = new Map(names.items.filter(item => item.name).map(item => [item.ticker, item.name]));
    reportNameWarning = names.failed ? '本地自选名称读取失败，未识别的标的暂显示代码。' : '';
    renderReports();
    const selected = reports.find(entry => entry.id === selectedReportId);
    if (selected?.ticker && !$('reader-document').hidden) $('document-title').textContent = `${stockName(selected.ticker)} 研究报告`;
    return reports;
  } catch (error) { if (request === reportRequest) $('reports-status').textContent = '读取报告失败：' + error.message; }
}
function stockName(ticker, savedName = '') {
  const code = String(ticker || '').trim().toUpperCase();
  return savedName || reportStockNames.get(code) || marketNames.get(code) || ticker || '历史报告';
}
function reportGroupKey(report) {
  const date = String(report.date || '');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T00:00:00Z') : null;
  return parsed && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date ? date : '';
}
function renderReports() {
    const query = $('report-search').value.trim().toLowerCase();
    const reports = reportsCache.filter(report => [stockName(report.ticker), report.ticker, report.date, report.title].some(value => String(value || '').toLowerCase().includes(query)));
    const list = $('report-list'); list.replaceChildren();
    $('reports-count').textContent = String(reportsCache.length);
    $('list-empty').hidden = reportsCache.length > 0 || !!query;
    $('reports-status').textContent = reports.length ? (query ? `找到 ${reports.length} 份报告` : '') : reportsCache.length ? '没有匹配的报告。' : query ? '没有匹配的报告。' : '';
    if (reportNameWarning) $('reports-status').textContent = [$('reports-status').textContent, reportNameWarning].filter(Boolean).join(' ');
    if (!selectedReportId && !$('reader-empty').hidden) {
      $('report-title').textContent = reportsCache.length ? '选择一份报告' : '还没有研究报告';
      $('report-help').textContent = reportsCache.length ? '从左侧报告库选择一份报告，继续你的研究。' : '分析完成后，报告会保存在本机，并出现在左侧的报告库中。';
    }
    const groups = new Map();
    for (const report of reports) {
      const group = reportGroupKey(report);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(report);
    }
    const dates = [...groups.keys()].sort((a, b) => a === '' ? 1 : b === '' ? -1 : b.localeCompare(a));
    for (const [index, date] of dates.entries()) {
      const group = document.createElement('details'); group.className = 'report-date-group';
      group.open = !!query || (reportGroupsOpen.has(date) ? reportGroupsOpen.get(date) : index === 0 || groups.get(date).some(report => report.id === selectedReportId));
      const summary = document.createElement('summary');
      const title = document.createElement('span'); title.className = 'report-date-label'; title.textContent = date || '未分类';
      const count = document.createElement('span'); count.className = 'report-date-count'; count.textContent = String(groups.get(date).length);
      summary.append(title, count);
      summary.addEventListener('click', event => { event.preventDefault(); group.open = !group.open; reportGroupsOpen.set(date, group.open); });
      group.append(summary);
      const items = document.createElement('div'); items.className = 'report-date-items';
      for (const report of groups.get(date)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'report-item';
      const selected = selectedReportId === report.id;
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
      const top = document.createElement('span'); top.className = 'report-item-top';
      const label = document.createElement('strong'); label.textContent = stockName(report.ticker);
      const icon = document.createElement('span'); icon.className = 'report-item-arrow'; icon.textContent = '↗';
      const meta = document.createElement('small'); meta.textContent = [report.ticker, report.date].filter(Boolean).join(' · ') || report.title;
      const detail = document.createElement('span'); detail.className = 'report-item-detail'; detail.textContent = report.title;
        top.append(label, icon); button.append(top, meta, detail); button.addEventListener('click', () => openReport(report)); items.append(button);
      }
      group.append(items); list.append(group);
    }
}

function appendInline(target, source) {
  const pattern = /\*\*[^*\n]+\*\*|`[^`\n]+`/g;
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    const value = match[0];
    if (value.startsWith('*')) {
      const inner = value.slice(value.startsWith('**') ? 2 : 1, value.startsWith('**') ? -2 : -1);
      if (/^\s|\s$/u.test(inner)) continue;
      const before = source[match.index - 1] || '';
      const after = source[match.index + value.length] || '';
      if ((before && /[A-Za-z0-9_]/.test(before)) || (after && /[A-Za-z0-9_]/.test(after))) continue;
    }
    target.append(document.createTextNode(source.slice(end, match.index)));
    const node = document.createElement(value.startsWith('**') ? 'strong' : 'code');
    node.textContent = value.slice(value.startsWith('**') ? 2 : 1, value.startsWith('**') ? -2 : -1);
    target.append(node);
    end = match.index + value.length;
  }
  target.append(document.createTextNode(source.slice(end)));
}

function tableCells(line, limit = 64) {
  let trimmed = line.trim().replace(/^\|/, '');
  if (trimmed.endsWith('|')) {
    let backslashes = 0;
    for (let index = trimmed.length - 2; index >= 0 && trimmed[index] === '\\'; index--) backslashes++;
    if (backslashes % 2 === 0) trimmed = trimmed.slice(0, -1);
  }
  const cells = []; let cell = ''; let escaped = false;
  for (const ch of trimmed) {
    if (escaped) { cell += ch === '|' ? '|' : '\\' + ch; escaped = false; }
    else if (ch === '\\') escaped = true;
    else if (ch === '|') { cells.push(cell.trim()); if (cells.length >= limit) return null; cell = ''; }
    else cell += ch;
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(line) {
  if (!line || !line.includes('|')) return false;
  const cells = tableCells(line);
  if (!cells) return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

// Render a safe Markdown subset as DOM; unsupported syntax stays visible as text.
function renderMarkdown(source, summaryOnly = false) {
  const root = summaryOnly ? document.createElement('div') : $('report-content'); root.replaceChildren();
  const toc = summaryOnly ? document.createElement('div') : $('report-toc-items'); toc.replaceChildren();
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const fragment = document.createDocumentFragment();
  let i = 0; const headings = [];
  const isBlock = (index) => {
    const line = lines[index] || '';
    return /^\s{0,3}(?:#{1,6}\s+|```|~~~|>|[-+*]\s+|\d+[.)]\s+)/.test(line)
      || /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
      || (line.includes('|') && isTableSeparator(lines[index + 1]));
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      const block = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) block.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = document.createElement('pre'); const code = document.createElement('code');
      code.textContent = block.join('\n'); pre.append(code); fragment.append(pre); continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      const node = document.createElement('h' + level); appendInline(node, heading[2].replace(/\s+#+\s*$/, '')); fragment.append(node);
      if (level <= 3) headings.push({ level, node });
      i++; continue;
    }
    if (line.includes('|') && isTableSeparator(lines[i + 1])) {
      const raw = [line, lines[i + 1]];
      const first = tableCells(line); const rows = first ? [first] : [];
      let width = first?.length || 0; let overflow = !first;
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const original = lines[i++]; raw.push(original);
        if (!overflow) {
          const row = tableCells(original);
          if (!row) overflow = true;
          else {
            width = Math.max(width, row.length); rows.push(row);
            overflow = rows.length > 500 || width * rows.length > 10000;
          }
        }
      }
      if (overflow) {
        const notice = document.createElement('p'); notice.textContent = '表格较大，以下显示原始文本。';
        const pre = document.createElement('pre'); pre.className = 'report-raw-table'; pre.textContent = raw.join('\n');
        fragment.append(notice, pre); continue;
      }
      const wrap = document.createElement('div'); wrap.className = 'report-table-wrap';
      const table = document.createElement('table');
      rows.forEach((row, index) => {
        const section = index === 0 ? document.createElement('thead') : table.tBodies[0] || document.createElement('tbody');
        const tr = document.createElement('tr');
        for (let n = 0; n < width; n++) { const cell = document.createElement(index === 0 ? 'th' : 'td'); appendInline(cell, row[n] || ''); tr.append(cell); }
        section.append(tr); if (!section.parentNode) table.append(section);
      });
      wrap.append(table); fragment.append(wrap); continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { fragment.append(document.createElement('hr')); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quote = document.createElement('blockquote');
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { if (quote.childNodes.length) quote.append(document.createElement('br')); appendInline(quote, lines[i++].replace(/^\s{0,3}>\s?/, '')); }
      fragment.append(quote); continue;
    }
    const list = line.match(/^([ \t]*)([-+*]|\d+[.)])\s+/);
    if (list) {
      const ordered = /^\d/.test(list[2]); const items = [];
      while (i < lines.length && /^([ \t]*)([-+*]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++]);
      const complex = items.some(item => { const parts = item.match(/^([ \t]*)([-+*]|\d+[.)])\s+/); return parts[1].length || /^\d/.test(parts[2]) !== ordered; });
      if (complex) {
        const pre = document.createElement('pre'); pre.className = 'report-raw-list'; pre.textContent = items.join('\n'); fragment.append(pre); continue;
      }
      const node = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered) node.start = Number.parseInt(list[2], 10);
      const expression = ordered ? /^\d+[.)]\s+/ : /^[-+*]\s+/;
      for (const item of items) { const li = document.createElement('li'); appendInline(li, item.replace(expression, '')); node.append(li); }
      fragment.append(node); continue;
    }
    const paragraph = document.createElement('p');
    do { if (paragraph.childNodes.length) paragraph.append(document.createElement('br')); appendInline(paragraph, lines[i++]); }
    while (i < lines.length && lines[i].trim() && !isBlock(i));
    fragment.append(paragraph);
  }
  root.append(fragment);
  const majorSections = headings.filter(({ level, node }) => level === 2 && /^(?:I|II|III|IV|V)\.\s+(?:Analyst Team Reports|Research Team Decision|Trading Team Plan|Risk Management Team Decision|Portfolio Manager Decision)$/i.test(node.textContent));
  const fallbackLevel = [1, 2, 3].find(level => headings.filter(item => item.level === level).length >= 2);
  const tocHeadings = (majorSections.length ? majorSections : headings.filter(item => item.level === fallbackLevel)).slice(0, 12);
  for (const { node } of tocHeadings) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = node.textContent;
    button.addEventListener('click', () => node.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    toc.append(button);
  }
  if (!summaryOnly) $('report-toc').hidden = tocHeadings.length < 2;
  return renderFinalDecision(headings, lines, !summaryOnly);
}

function isReportSectionBoundary(node) {
  if (node.tagName !== 'H2') return false;
  const text = node.textContent.trim();
  if (/^(?:I|II|III|IV|V)\.\s+(?:Analyst Team Reports|Research Team Decision|Trading Team Plan|Risk Management Team Decision|Portfolio Manager Decision)$/i.test(text)) return true;
  const match = text.match(/^([IVXLCDM]+)\.\s+/);
  if (!match) return false;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const digits = [...match[1]].map(ch => values[ch]);
  return digits.reduce((sum, digit, index) => sum + (digit < (digits[index + 1] || 0) ? -digit : digit), 0) > 5;
}

function reportHeaderRatings(lines) {
  const first = lines.findIndex(line => line.trim());
  if (first < 0 || !/^# Trading Analysis Report(?::\s*.*)?\s*$/.test(lines[first])) return [];
  const header = [];
  for (let i = first + 1; i < lines.length && !/^\s{0,3}#{1,6}\s+/.test(lines[i]); i++) header.push(lines[i]);
  const matches = header.map(line => line.match(/^- Rating:\s*(\S.{0,199})\s*$/)).filter(Boolean);
  return matches.map(match => match[1].trim());
}

function renderRating(decision, lines, nodes) {
  const header = reportHeaderRatings(lines);
  // Older reports may omit the header rating; only an explicit opening rating in the final manager's section is safe to use.
  const opening = nodes.find(node => !/^H[1-6]$/.test(node.tagName) && node.textContent.trim());
  const openingLine = opening?.tagName === 'P' ? opening
    : ['UL', 'OL'].includes(opening?.tagName) && opening.firstElementChild?.tagName === 'LI' ? opening.firstElementChild : null;
  const firstLine = [];
  if (openingLine) {
    for (const child of openingLine.childNodes) {
      if (['BR', 'UL', 'OL'].includes(child.nodeName)) break;
      firstLine.push(child.textContent);
    }
  }
  const match = firstLine.join('').trim().match(/^Rating\s*[:：]\s*(Buy|Overweight|Hold|Underweight|Sell|REVIEW)\s*$/i);
  const bodyRating = match?.[1] || '';
  const raw = header.length === 1 ? header[0] : header.length === 0 ? bodyRating : '';
  const ratings = {
    buy: ['买入', '报告给出买入评级；具体条件和风险请看下方原文。'],
    overweight: ['偏买 · 增持', '报告倾向提高配置；买入时机和仓位请看下方原文。'],
    hold: ['持有 / 观望', '报告给出持有评级；具体条件和风险请看下方原文。'],
    underweight: ['偏卖 · 减持', '报告倾向降低配置；具体条件和风险请看下方原文。'],
    sell: ['卖出', '报告给出卖出评级；具体条件和风险请看下方原文。'],
    review: ['需要复核', '报告未形成可识别的交易评级，请阅读原文。'],
  };
  const normalized = raw.toLowerCase();
  const conflict = header.length > 1 || (header.length === 1 && bodyRating && header[0].toLowerCase() !== bodyRating.toLowerCase());
  const rating = !conflict && Object.hasOwn(ratings, normalized) ? ratings[normalized] : null;
  const wrapper = document.createElement('div'); wrapper.className = 'report-rating';
  const title = document.createElement('strong'); title.className = 'report-rating-title';
  title.textContent = conflict ? '评级不一致，需要复核' : rating ? rating[0] : '未识别最终评级';
  const original = document.createElement('span'); original.className = 'report-rating-original';
  original.textContent = conflict ? (header.length > 1 ? '报告头包含多个评级' : `报告头：${header[0]} · 决策正文：${bodyRating}`) : raw ? `原始评级：${raw}` : '报告没有明确的最终评级';
  const detail = document.createElement('p'); detail.className = 'report-rating-detail';
  detail.textContent = conflict ? '报告中的评级不一致，请核对下方原文。' : rating ? rating[1] : '请阅读下方原文，不要据此推断买卖方向。';
  wrapper.append(title, original, detail); decision.append(wrapper);
  return title.textContent;
}

function renderFinalDecision(headings, lines, attach = true) {
  const previous = attach && $('reader-document').querySelector('.report-decision');
  if (previous) previous.remove();
  const decision = document.createElement('section'); decision.className = 'report-decision';
  const label = document.createElement('h3'); label.className = 'report-decision-label'; label.textContent = '最终交易建议'; decision.append(label);
  const section = headings.find(({ level, node }) => level === 2 && /^V\.\s+Portfolio Manager Decision$/i.test(node.textContent));
  const manager = section?.node.nextElementSibling;
  const nodes = [];
  if (manager?.tagName === 'H3' && /^Portfolio Manager$/i.test(manager.textContent)) {
    for (let node = manager.nextElementSibling; node && !isReportSectionBoundary(node); node = node.nextElementSibling) nodes.push(node);
  }
  const rating = renderRating(decision, lines, nodes);
  if (!attach) return rating;
  const hasContent = nodes.some(node => !/^H[1-6]$/.test(node.tagName) && node.textContent.trim());
  if (hasContent) {
    const content = document.createElement('div'); content.className = 'report-decision-content report-content';
    for (const node of nodes) content.append(node.cloneNode(true));
    decision.append(content);
  } else {
    const empty = document.createElement('p'); empty.className = 'report-decision-empty';
    const header = reportHeaderRatings(lines);
    const rating = header.length === 1 ? header[0] : '';
    empty.textContent = rating ? `最终评级（报告元数据）：${rating}。未找到最终建议正文，请阅读下方完整报告。` : '未找到明确的最终交易建议，请阅读下方完整报告。';
    decision.append(empty);
  }
  $('report-toc').before(decision);
  return rating;
}

async function openReport(entry) {
  const request = ++readRequest;
  reportGroupsOpen.set(reportGroupKey(entry), true);
  selectedReportId = entry.id; renderReports();
  $('reader-empty').hidden = false; $('reader-document').hidden = true;
  $('report-title').textContent = '正在读取报告…'; $('report-help').textContent = '请稍候。';
  try {
    const report = await window.desktop.readReport(entry.id);
    if (request !== readRequest) return;
    $('document-title').textContent = entry.ticker ? `${stockName(entry.ticker)} 研究报告` : report.title;
    $('report-meta').textContent = [entry.ticker, entry.date, '已保存到本机'].filter(Boolean).join('  ·  ');
    $('report-meta').title = report.title || '';
    renderMarkdown(report.text);
    $('reader-empty').hidden = true; $('reader-document').hidden = false;
    document.querySelector('.reader-paper').scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) { if (request === readRequest) { $('report-title').textContent = '无法读取报告'; $('report-help').textContent = error.message; } }
}
$('report-search').addEventListener('input', renderReports);
$('open-latest').addEventListener('click', async () => {
  const id = latestReportId;
  if (!id) return;
  $('report-search').value = '';
  showPage('reader');
  const reports = await loadReports();
  if (reports) {
    const report = reports.find(entry => entry.id === id);
    if (report) openReport(report);
    else $('reports-status').textContent = '未找到本次报告，请刷新列表。';
  }
});
$('refresh-reports').addEventListener('click', loadReports);
$('open-reports').addEventListener('click', async () => {
  try { const error = await window.desktop.reports(); if (error) $('reports-status').textContent = error; }
  catch (error) { $('reports-status').textContent = error.message; }
});

function syncWatchProfiles() {
  const select = $('watch-profile');
  const current = select.value;
  select.replaceChildren();
  if (!profileState.profiles.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = '请先在 API 设置中添加连接'; select.append(option);
  }
  for (const profile of profileState.profiles) {
    const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.model ? `${profile.name} · ${profile.model}` : profile.name; select.append(option);
  }
  select.value = profileState.profiles.some(profile => profile.id === current) ? current : profileState.selectedId || '';
}

function renderWatchlist() {
  const list = $('watch-list'); list.replaceChildren();
  $('watch-total').textContent = String(watchlist.length);
  $('watch-count').textContent = watchlist.length ? String(watchlist.length) : '';
  $('watch-empty').hidden = watchlist.length > 0;
  $('watch-run').disabled = batchBusy || operationBusy || !watchlist.length;
  $('watch-add-form').querySelector('button').disabled = batchBusy;
  $('watch-date').disabled = batchBusy;
  $('watch-profile').disabled = batchBusy;
  $('watch-stop').hidden = !batchBusy;
  for (const item of watchlist) {
    const row = document.createElement('article'); row.className = 'watch-item';
    const avatar = document.createElement('span'); avatar.className = 'watch-avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = item.ticker.slice(0, 2);
    const identity = document.createElement('div'); identity.className = 'watch-identity';
    const ticker = document.createElement('strong'); ticker.textContent = stockName(item.ticker, item.name);
    const name = document.createElement('span'); name.textContent = item.ticker;
    identity.append(ticker, name);
    const result = watchResults.get(item.ticker);
    row.dataset.state = result?.status || (result?.reportId ? 'completed' : 'idle');
    const info = document.createElement('div'); info.className = 'watch-result';
    const status = document.createElement('strong'); status.textContent = result?.label || '尚无分析';
    const meta = document.createElement('span'); meta.textContent = result?.detail || '添加后可逐只分析';
    info.append(status, meta);
    const actions = document.createElement('div'); actions.className = 'watch-item-actions';
    const analyze = document.createElement('button'); analyze.type = 'button'; analyze.className = 'text-button'; analyze.textContent = '选择分析 →';
    analyze.setAttribute('aria-label', `选择分析 ${item.ticker}`); analyze.addEventListener('click', () => selectForAnalysis(item.ticker)); actions.append(analyze);
    if (result?.reportId) {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'text-button'; open.textContent = result.previousReport ? '阅读上次报告 →' : '阅读报告 →';
      open.addEventListener('click', () => openWatchReport(result.reportId)); actions.append(open);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '移除'; remove.disabled = batchBusy;
    remove.setAttribute('aria-label', `移除 ${item.ticker}`); remove.addEventListener('click', () => removeWatchlist(item.ticker)); actions.append(remove);
    row.append(avatar, identity, info, actions); list.append(row);
  }
}

async function refreshWatchlist() {
  if (!window.desktop.watchlist) { $('watch-message').textContent = '自选功能不可用，请重启应用。'; return; }
  const revision = ++watchRevision;
  try {
    const items = await window.desktop.watchlist();
    if (revision !== watchRevision) return;
    watchlist = items; renderWatchlist();
    loadWatchReports(revision);
  } catch (error) { if (revision === watchRevision) $('watch-message').textContent = '读取自选失败：' + error.message; }
}

async function loadWatchReports(revision) {
  if (!window.desktop.reportsList || !window.desktop.readReport) return;
  try {
    const reports = await window.desktop.reportsList();
    for (const item of watchlist) {
      if (revision !== watchRevision) return;
      if (watchResults.get(item.ticker)?.reportId) continue;
      const entry = reports.find(report => report.ticker === item.ticker);
      if (!entry) continue;
      const pending = watchResults.get(item.ticker);
      if (pending) {
        pending.reportId = entry.id; pending.previousReport = true; renderWatchlist();
        continue;
      }
      try {
        const report = await window.desktop.readReport(entry.id);
        if (revision !== watchRevision) continue;
        const current = watchResults.get(item.ticker);
        if (current) {
          if (!current.reportId) { current.reportId = entry.id; current.previousReport = true; renderWatchlist(); }
          continue;
        }
        watchResults.set(item.ticker, { status: 'completed', label: renderMarkdown(report.text, true), detail: entry.date || '已保存报告', reportId: entry.id });
        renderWatchlist();
      } catch { /* The report may have disappeared since the list was read. */ }
    }
  } catch { /* Reports remain optional when editing a watchlist. */ }
}

async function addWatchlist(item) {
  if (!window.desktop.watchlistAdd) return;
  const revision = ++watchRevision;
  try {
    const items = await window.desktop.watchlistAdd(item);
    if (revision !== watchRevision) return;
    watchlist = items; renderWatchlist();
    $('watch-message').textContent = `已加入自选：${item.ticker.toUpperCase()}`;
    $('watch-add-status').textContent = `已加入自选：${item.ticker.toUpperCase()}`;
  } catch (error) {
    $('watch-message').textContent = '添加自选失败：' + error.message;
    $('watch-add-status').textContent = '添加自选失败：' + error.message;
    if (document.querySelector('[data-view="analysis"]:not([hidden])')) showTaskError('添加自选失败', error.message);
  }
}

async function removeWatchlist(ticker) {
  const revision = ++watchRevision;
  try {
    const items = await window.desktop.watchlistRemove(ticker);
    if (revision !== watchRevision) return;
    watchlist = items; watchResults.delete(ticker); renderWatchlist();
    $('watch-message').textContent = `已移除 ${ticker}`;
  } catch (error) { $('watch-message').textContent = '移除自选失败：' + error.message; }
}

async function openWatchReport(id) {
  try {
    const reports = await window.desktop.reportsList();
    const report = reports.find(entry => entry.id === id);
    if (!report) { $('watch-message').textContent = '报告不存在，请刷新后重试。'; return; }
    $('report-search').value = ''; showPage('reader'); openReport(report);
  } catch (error) { $('watch-message').textContent = '打开报告失败：' + error.message; }
}

async function updateWatchProgress(event) {
  const labels = { waiting: '等待分析', running: '分析中…', completed: '报告已保存', failed: '分析失败', stopped: '已停止', cancelled: '已取消' };
  if (!event || !labels[event.status]) return;
  const detail = event.error || (event.code != null && event.code !== 0 ? `退出码 ${event.code}` : '');
  const previousReportId = watchResults.get(event.ticker)?.reportId || null;
  const item = { status: event.status, label: labels[event.status], detail, reportId: event.reportId || previousReportId, previousReport: !event.reportId && Boolean(previousReportId) };
  watchResults.set(event.ticker, item); renderWatchlist();
  if (event.status === 'completed' && event.reportId && window.desktop.readReport) {
    try {
      const report = await window.desktop.readReport(event.reportId);
      if (watchResults.get(event.ticker) !== item) return;
      item.label = renderMarkdown(report.text, true); item.detail = `${event.date || $('watch-date').value} · 已保存报告`; renderWatchlist();
    } catch { if (watchResults.get(event.ticker) === item) { item.detail = '报告读取失败，请在报告库中重试。'; renderWatchlist(); } }
  }
}

if (window.desktop.onBatchProgress) window.desktop.onBatchProgress(updateWatchProgress);
$('watch-date').value = $('date').value;
$('watch-add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const ticker = $('watch-ticker').value.trim();
  if (!ticker) return;
  await addWatchlist({ ticker });
  if (watchlist.some(item => item.ticker === ticker.toUpperCase())) $('watch-ticker').value = '';
});
$('watch-add-current').addEventListener('click', () => addWatchlist({ ticker: $('ticker').value.trim() }));

function selectForAnalysis(ticker) {
  $('ticker').value = ticker; showPage('analysis'); $('ticker').focus();
}

let holdings = [];
let holdingsRevision = 0;
function renderHoldings() {
  const list = $('holdings-list'); list.replaceChildren();
  $('holdings-total').textContent = String(holdings.length);
  $('holdings-empty').hidden = holdings.length > 0;
  for (const item of holdings) {
    const row = document.createElement('article'); row.className = 'watch-item';
    const avatar = document.createElement('span'); avatar.className = 'watch-avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = item.ticker.slice(0, 2);
    const identity = document.createElement('div'); identity.className = 'watch-identity';
    const name = document.createElement('strong'); name.textContent = stockName(item.ticker, item.name);
    const code = document.createElement('span'); code.textContent = item.ticker; identity.append(name, code);
    const actions = document.createElement('div'); actions.className = 'watch-item-actions';
    const analyze = document.createElement('button'); analyze.type = 'button'; analyze.className = 'text-button'; analyze.textContent = '选择分析 →';
    analyze.setAttribute('aria-label', `选择分析持仓 ${item.ticker}`); analyze.addEventListener('click', () => selectForAnalysis(item.ticker));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除持仓 ${item.ticker}`); remove.addEventListener('click', () => changeHoldings(() => window.desktop.holdingsRemove(item.ticker), `已移除 ${item.ticker}`));
    actions.append(analyze, remove); row.append(avatar, identity, actions); list.append(row);
  }
}
async function refreshHoldings() {
  if (!window.desktop.holdings) { $('holdings-message').textContent = '持仓功能不可用，请重启应用。'; return; }
  const revision = ++holdingsRevision;
  try { const items = await window.desktop.holdings(); if (revision === holdingsRevision) { holdings = items; renderHoldings(); } }
  catch (error) { if (revision === holdingsRevision) $('holdings-message').textContent = '读取持仓失败：' + error.message; }
}
async function changeHoldings(action, success) {
  const revision = ++holdingsRevision;
  try { const items = await action(); if (revision !== holdingsRevision) return false; holdings = items; renderHoldings(); $('holdings-message').textContent = success; return true; }
  catch (error) { $('holdings-message').textContent = '更新持仓失败：' + error.message; return false; }
}
$('holdings-add-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!window.desktop.holdingsAdd) { $('holdings-message').textContent = '持仓功能不可用，请重启应用。'; return; }
  const ticker = $('holdings-ticker').value.trim(); const name = $('holdings-name').value.trim();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { if (await changeHoldings(() => window.desktop.holdingsAdd({ ticker, name }), `已添加持仓：${ticker.toUpperCase()}`)) { $('holdings-ticker').value = ''; $('holdings-name').value = ''; } }
  finally { button.disabled = false; }
});
$('watch-run').addEventListener('click', async () => {
  if (batchBusy || operationBusy || !watchlist.length) return;
  if (!window.desktop.runBatch) { $('watch-message').textContent = '批量分析功能不可用，请重启应用。'; return; }
  const tickers = watchlist.map(item => item.ticker);
  const date = $('watch-date').value; const profileId = $('watch-profile').value;
  if (!date || !profileId) { $('watch-message').textContent = '请选择分析日期和模型连接。'; return; }
  batchBusy = analysisBusy = operationBusy = true;
  $('run').disabled = true;
  renderUpdateState();
  $('stop-run').hidden = false; $('stop-run').disabled = false;
  $('open-latest').hidden = true; $('log').textContent = '';
  lastLogScrollTop = 0;
  $('status').textContent = '批量分析中…'; document.querySelector('.status-pill').dataset.state = 'busy';
  for (const ticker of tickers) {
    const previousReportId = watchResults.get(ticker)?.reportId || null;
    watchResults.set(ticker, { status: 'waiting', label: '等待分析', detail: '', reportId: previousReportId, previousReport: Boolean(previousReportId) });
  }
  $('watch-message').textContent = `正在逐只分析 ${tickers.length} 个标的。`; renderWatchlist();
  try {
    const result = await window.desktop.runBatch({ tickers, date, profileId });
    const failed = result.results.filter(item => item.error || (!item.stopped && (item.code !== 0 || !item.reportId))).length;
    $('watch-message').textContent = result.stopped ? '批次已停止；已完成的报告保留在本机。' : failed ? `批次结束，${failed} 项未完成；请查看对应状态与日志。` : '批次已完成，报告保存在本机。';
    $('status').textContent = result.stopped ? '批次已停止' : failed ? '批次结束，部分未完成' : '批次完成';
    document.querySelector('.status-pill').dataset.state = result.stopped ? 'stopped' : failed ? 'error' : 'complete';
  } catch (error) {
    $('watch-message').textContent = '批量分析失败：' + error.message;
    $('status').textContent = '批量分析失败'; document.querySelector('.status-pill').dataset.state = 'error';
    for (const ticker of tickers) if (watchResults.get(ticker)?.status === 'waiting') watchResults.set(ticker, { ...watchResults.get(ticker), status: 'failed', label: '未开始', detail: '批次启动失败' });
  } finally {
    batchBusy = analysisBusy = operationBusy = false;
    $('run').disabled = false;
    renderUpdateState();
    $('stop-run').hidden = true; $('watch-stop').disabled = false; renderWatchlist();
  }
});
$('watch-stop').addEventListener('click', async () => {
  $('watch-stop').disabled = true;
  try { const result = await window.desktop.stop(); if (result.requested && batchBusy) $('watch-message').textContent = '正在停止当前分析，并取消剩余任务…'; }
  catch (error) { $('watch-message').textContent = '停止失败：' + error.message; if (batchBusy) $('watch-stop').disabled = false; }
});

const markets = [
  ['美国 · NYSE / Nasdaq', [['苹果','AAPL'],['微软','MSFT'],['英伟达','NVDA'],['标普 500 ETF','SPY']]],
  ['中国内地 · 上海 / 深圳', [['贵州茅台','600519.SS'],['中国平安','601318.SS'],['平安银行','000001.SZ'],['宁德时代','300750.SZ'],['黄河旋风','600172.SS']]],
  ['中国香港 · 港交所', [['腾讯控股','0700.HK'],['阿里巴巴','9988.HK'],['香港交易所','0388.HK']]],
  ['日本 · 东京', [['丰田汽车','7203.T'],['索尼集团','6758.T']]],
  ['韩国 · 首尔', [['三星电子','005930.KS'],['SK 海力士','000660.KS']]],
  ['英国 · 伦敦', [['阿斯利康','AZN.L'],['汇丰控股','HSBA.L']]],
  ['其他资产', [['比特币 / 美元','BTC-USD'],['以太坊 / 美元','ETH-USD']]],
];
const marketNames = new Map(markets.flatMap(([, examples]) => examples.map(([name, ticker]) => [ticker, name])));
// Legacy reports used this bare code; do not infer exchanges for other numeric symbols.
marketNames.set('600172', marketNames.get('600172.SS'));
function renderMarkets() {
const query = $('market-search').value.trim().toLowerCase();
const list = $('market-list'); list.replaceChildren();
let count = 0;
for (const [market, allExamples] of markets) {
  const examples = allExamples.filter(([name, ticker]) => `${market} ${name} ${ticker}`.toLowerCase().includes(query));
  if (!examples.length) continue;
  const card = document.createElement('section'); card.className = 'market-card';
  const heading = document.createElement('h2'); heading.textContent = market; card.append(heading);
  for (const [name, ticker] of examples) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'market-item';
    const label = document.createElement('span'); label.textContent = name;
    const code = document.createElement('code'); code.textContent = ticker;
    button.append(label, code); button.addEventListener('click', () => selectForAnalysis(ticker)); card.append(button);
  }
  list.append(card); count += examples.length;
}
$('market-status').textContent = count ? '' : '没有匹配的市场或代码。';
}
$('market-search').addEventListener('input', renderMarkets);
renderMarkets();
function renderScreenResult(result) {
  const root = $('screen-results'); root.replaceChildren();
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const verified = candidates.filter(item => item.profitStatus === 'verified_positive' && typeof item.netProfit === 'number' && Number.isFinite(item.netProfit) && item.netProfit > 0);
  const groups = [['已披露盈利候选（按成交额，最多展示 5 只）', verified.slice(0, 5)]];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    const section = document.createElement('section'); section.className = 'screen-group';
    const heading = document.createElement('h3'); heading.textContent = `${title} · ${items.length}`; section.append(heading);
    for (const item of items) {
      const row = document.createElement('article'); row.className = 'screen-item';
      const identity = document.createElement('div'); identity.className = 'watch-identity';
      const label = document.createElement('strong'); label.textContent = item.name || item.ticker;
      const code = document.createElement('span'); code.textContent = item.ticker;
      identity.append(label, code);
      const stats = document.createElement('div'); stats.className = 'screen-stats';
      const text = (label, value, suffix = '') => `${label} ${typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + suffix : '暂无'}`;
      const values = [text('价格', item.price), text('涨跌', item.changePercent, '%'), text('换手', item.turnoverPercent, '%'), text('成交额', typeof item.turnoverAmount === 'number' ? item.turnoverAmount / 100000000 : null, '亿元')];
      if (item.profitStatus === 'verified_positive') values.push(text('归母净利润', typeof item.netProfit === 'number' ? item.netProfit / 100000000 : null, '亿元'));
      stats.textContent = values.join(' · ') + (item.reportDate ? ` · 财报 ${item.reportDate}` : '') + (item.announcementDate ? ` · 披露 ${item.announcementDate}` : '');
      const add = document.createElement('button'); add.type = 'button'; add.className = 'button button-subtle'; add.textContent = '＋ 自选';
      add.setAttribute('aria-label', `添加 ${item.name || item.ticker} 到自选`);
      add.addEventListener('click', async () => { await addWatchlist({ ticker: item.ticker, name: item.name || '' }); $('screen-action-status').textContent = $('watch-message').textContent; });
      const analyze = document.createElement('button'); analyze.type = 'button'; analyze.className = 'button button-subtle'; analyze.textContent = '选择分析';
      analyze.setAttribute('aria-label', `选择分析 ${item.name || item.ticker}`); analyze.addEventListener('click', () => selectForAnalysis(item.ticker));
      row.append(identity, stats, add, analyze); section.append(row);
    }
    root.append(section);
  }
  if (!verified.length) { const empty = document.createElement('p'); empty.className = 'watch-empty'; empty.textContent = '本次没有符合筛选条件的候选。'; root.append(empty); }
  return candidates.length - verified.length;
}
$('screen-ashares').addEventListener('click', async () => {
  if (!window.desktop.screenAShares) { $('screen-status').textContent = '候选筛选暂不可用，请重启应用。'; return; }
  $('screen-ashares').disabled = true; $('screen-action-status').textContent = ''; $('screen-status').textContent = '正在读取公开行情与财务数据…';
  try {
    const result = await window.desktop.screenAShares();
    const excluded = renderScreenResult(result);
    const messages = [result.source || '公开数据', result.marketDate ? `行情日期 ${result.marketDate}` : '行情日期未提供', result.fetchedAt ? `获取时间 ${result.fetchedAt}` : '', result.cached ? '本地缓存' : '', excluded ? `${excluded} 条盈利条件未通过，已排除` : '', ...(Array.isArray(result.warnings) ? result.warnings : [])].filter(Boolean);
    $('screen-status').textContent = messages.join(' · ');
  } catch (error) { $('screen-results').replaceChildren(); $('screen-status').textContent = '筛选失败：' + error.message; }
  finally { $('screen-ashares').disabled = false; }
});
$('screen-home').addEventListener('click', () => { showPage('markets'); $('screen-ashares').click(); });
toggleProvider();
scheduleModelCatalog();
loadProfiles();
loadFredStatus();
