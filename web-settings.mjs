const errors = {
  WEB_PROVIDER_CREDENTIAL_MISSING: 'DeepSeek 搜索缺少凭据。可在下方保存官方 API Key。',
  WEB_PROVIDER_CONFIGURED_MISSING: '所选搜索提供商没有加载。',
  WEB_PROVIDER_CONFIGURED_UNAVAILABLE: '所选搜索提供商未就绪。',
  WEB_PROVIDER_UNAVAILABLE: '没有可用的搜索提供商。',
  BROWSER_MISSING: '请先在这台电脑上安装 Chrome 或 Edge。',
  BROWSER_DISABLED: '浏览器未启用。',
  BROWSER_BUSY: '浏览器忙，请稍后重试。',
};
const failure = error => ({ status: 'failed', code: Object.hasOwn(errors, error?.code) ? error.code : 'WEB_TEST_FAILED',
  message: errors[error?.code] ?? '测试未取得结果，请检查服务配置或网络。' });

export async function manageWeb(ctx, request, signal = new AbortController().signal) {
  const web = ctx.get('web'), browser = ctx.get('maomaoBrowser'), vault = ctx.get('credentials');
  if (request?.action === 'read') {
    let searchProvider = null, fetchProvider = null;
    try { searchProvider = web?.selectSearchProvider?.()?.id ?? null; } catch { /* Report missing selection below. */ }
    try { fetchProvider = web?.selectFetchProvider?.()?.id ?? null; } catch { /* Same. */ }
    return { searchProvider, fetchProvider,
      searchReady: await web?.searchReady?.().catch(() => false) ?? false,
      deepseekCredential: (await vault?.describe?.('DEEPSEEK_API_KEY').catch(() => null))?.configured === true,
      browser: browser?.status?.() ?? { enabled: false, installed: false, running: false, active: 0 } };
  }
  if (request?.action === 'credential') {
    if (!vault?.set || typeof request.secret !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(request.secret)) return { status: 'invalid' };
    try { await vault.set('DEEPSEEK_API_KEY', request.secret); return { status: 'saved' }; } catch { return { status: 'failed' }; }
  }
  if (request?.action === 'browser') {
    const editor = ctx.get('configEditor');
    const entry = editor?.entries().find(row => row.options.id === 'maomao-dsh-panel');
    if (!entry || typeof request.enabled !== 'boolean') return { status: 'invalid' };
    await editor.edit(entry, config => ({ ...config, browser: { enabled: request.enabled } }));
    return { status: 'saved' };
  }
  if (request?.action === 'test_search') {
    try {
      const found = await web.search({ query: 'DeepSeek Harness 官方文档', maxResults: 3 },
        AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
      const sources = (found.sources ?? []).slice(0, 3).map(row => ({ title: String(row.title ?? '').slice(0, 140), url: String(row.url ?? '').slice(0, 1500) }));
      return { status: sources.length || found.content ? 'tested' : 'empty', sources };
    } catch (error) { return failure(error); }
  }
  if (request?.action === 'test_browser') {
    const lease = browser?.lease('maomao-panel-check');
    if (!lease) return { status: 'failed' };
    try {
      const page = await lease.run('open', { url: 'https://example.com/' }, AbortSignal.any([signal, AbortSignal.timeout(35_000)]));
      browser.record('ok');
      return { status: 'tested', title: page.title, url: page.url, content: page.content.slice(0, 500) };
    } catch (error) { browser.record('unavailable'); return failure(error); }
    finally { await lease.close(); }
  }
  return { status: 'invalid' };
}
