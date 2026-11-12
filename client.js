window.__ModuleLoader__.load({
  id: 'maomao-dsh-panel',
  factory(require) {
    const { createElement: h, Fragment: ReactFragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } = require('react');
    const states = { ready: '已连接', waiting: '等待连接', off: '未启用' };
    const sharedMemoryStates = { off: '未开启', active: '正在共享', waiting_channels: '已开启 · 还差另一个私聊渠道',
      waiting_owner: '已开启 · 还没有私聊绑定到同一位主人' };
    const modes = { off: '未启用', manual: '仅手动', shadow: '模拟', send: '实际发送' };
    const results = { unavailable: '暂不满足发送条件', shadow: '已模拟', denied: '请求被拒绝',
      cancelled: '已取消', uncertain: '投递待确认', sent: '已投递' };
    const destinations = { desktop: '桌面会话', feishu: 'Lark / 飞书', telegram: 'Telegram', qq: 'QQ' };
    const platforms = ['feishu', 'telegram', 'qq'];
    const pairingTitles = { feishu: '绑定飞书 / Lark 私聊', telegram: '绑定 Telegram 私聊', qq: '绑定 QQ 群或私聊' };
    const mediaLabels = {
      ok: '下载成功', lark_permission: '缺少读取消息资源的权限（99991672），检查 im:message:readonly 和版本发布',
      permission: '平台拒绝访问，检查应用权限或凭据', missing: '资源不存在或已经过期', rate_limit: '触发平台限流',
      http: '平台下载接口返回错误', size: '图片超过 5 MB', format: '图片格式不受支持',
      empty: '平台返回空文件', network: '连接下载服务失败（已自动重试一次）', timeout: '下载超时（已自动重试一次）', unsafe_source: '图片来源不在 QQ 白名单内',
      client_error: '平台拒绝了下载请求',
    };
    const pairingLabels = {
      unavailable: '连接未就绪或所选主人已不可用。', expired: '配对码已失效，请重新生成。',
      waiting: '还没收到聊天中的配对指令。', invalid: '确认码不正确，连续输错五次后需要重新生成。',
      already_bound: '这个会话已绑定。', bound: '已绑定，可以开始聊天。', cancelled: '已取消配对。',
      reassigned: '已关联到同一主人。', binding_changed: '绑定已变更，请刷新后重新操作。',
      locked: '确认码连续输错五次，请重新生成。', busy: '这个渠道已有配对，继续填写确认码或先取消。',
      choose_owner: '请先选择这个私聊属于哪位主人，或设为新的主人。',
    };
    const previewLabels = {
      disabled: '尚未启用定时主动分享。', busy: '正在处理另一条消息或分享任务。', offline: '目标渠道尚未连接。',
      route_unverified: '目标私聊还没有收到普通消息。', recent_chat: '距离上次聊天不足 75 分钟。',
      policy: '当前不满足主动分享条件。', failed: '试跑遇到错误。', goodnight: '正在晚安免打扰时段。',
      dnd: '正在免打扰时段。', future_activity: '记录时间与当前时钟不一致。', pending: '还有一条分享待确认。',
      daily_limit: '已达到当天的分享次数上限。', waiting_for_reply: '猫猫还在等上一次分享的回复。',
      cooldown: '距离上次分享还在冷却期。', no_candidate: '这次没有合适的分享内容。',
    };
    const connectionErrors = {
      busy: '这个渠道已有一项操作在进行。', confirm_exclusive: '请确认同一个 Bot 只由这个实例连接。',
      setup_missing: '此配置尚未安装对应的猫猫连接器。', credentials_rejected: '凭据验证失败，请核对后重试。',
      telegram_http_409: '另一个进程正在读取这个 Bot 的消息。', telegram_webhook_or_status_unknown: 'Telegram Bot 仍配置了 Webhook，或未能读取其状态。',
      telegram_management_disabled: '这个管理 Bot 还未开启 Bot Management Mode。',
      feishu_token_unavailable: '平台未授予应用凭据，请检查版本发布和应用所在租户。',
      wrong_edition: '扫描使用的飞书版本与当前选择不一致。', managed_credentials_required: '请先导入这个 Bot 的凭据。',
      configuration_unavailable: '桌面配置已变更，请刷新后重试。', configuration_rejected: '配置保存失败，检查是否有更高优先级的覆盖配置。',
      expired: '授权已超时，请重新开始。', expired_token: '二维码已过期，请重新开始。',
      access_denied: '平台没有批准授权。', invalid_qr: '平台返回的二维码地址无法验证。',
    };
    const connectionLabels = { preparing: '正在准备…', scan: '等待平台授权…', verifying: '正在验证凭据…',
      saving: '正在保存并启动连接器…', connected: '已保存，正在连接 Bot。', verified: '平台凭据验证成功。', disconnected: '已断开，可随时重新连接。',
      cancelled: '已取消。' };
    const activeConnection = (job) => ['preparing', 'scan', 'verifying', 'saving'].includes(job?.state);
    const enabled = (value) => value ? '已启用' : '未启用';
    // 字级规范（参照 macOS HIG 文本样式，面板基准 13px）：5 个字号、2 个字重。
    //   title    20px/600  页面标题（h2），每页一个
    //   lead     16px/600  总览的摘要句、品牌名；全面板最多一两处
    //   headline 14px/600  区块标题（h3）、渠道名
    //   body     13px/400  正文与控件；h4 和需要强调的正文用 600
    //   caption  12px/400  元数据、状态、导航分组标签；低于 12px 不使用
    // 新增文字只从这里取值，不写数字字号，也不使用 650/700 等其他字重。
    const type = { title: 'var(--maomao-font-title)', lead: 'var(--maomao-font-lead)', headline: 'var(--maomao-font-headline)',
      body: 'var(--maomao-font-body)', caption: 'var(--maomao-font-caption)' };
    const sectionStyle = {
      border: '1px solid var(--dsw-alias-border-default, rgba(127, 127, 127, 0.28))',
      borderRadius: 12, padding: '14px 16px', minWidth: 0,
    };
    const inputStyle = { ...sectionStyle, padding: '5px 9px', fontSize: type.body, maxWidth: '100%', background: 'transparent' };
    const lineStyle = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
    // HIG: one prominent action per step, destructive actions look destructive.
    const variants = { primary: 'maomao-primary', destructive: 'maomao-destructive', confirmDestructive: 'maomao-destructive maomao-confirm' };
    const button = (label, onClick, disabled, variant) => h('button', { type: 'button', style: inputStyle, className: variants[variant], onClick, disabled }, label);
    const unsavedStyle = { ...inputStyle, background: 'rgba(224, 154, 30, 0.22)', borderColor: '#b8791f', fontWeight: 600 };
    const saveControl = (label, onClick, disabled, dirty, type = 'button') => h('div', { style: lineStyle },
      h('button', { type, style: inputStyle, className: dirty ? variants.primary : undefined, onClick, disabled }, label),
      h('span', { role: 'status', className: 'maomao-unsaved' }, dirty ? '未保存' : ''));
    const timestamp = (at) => new Date(at).toLocaleString('zh-CN');

    const stackStyle = { display: 'grid', gap: 14, minWidth: 0 };
    const mutedStyle = { margin: 0, fontSize: type.body, opacity: 0.72, lineHeight: 1.65 };
    const panelPages = {
      home: ['总览', '先让猫猫聊起来，再按需开启更多能力。'],
      channels: ['渠道与会话', '先连接 Bot，再授权聊天。主人身份和聊天权限分别管理。'],
      personas: ['人设', '管理角色设定，以及每个群和私聊使用的角色。'],
      models: ['模型与能力', '按用途选择模型。默认优先复用 DSH 保存的服务凭据。'],
      memory: ['记忆', '查看猫猫记住的内容，管理记忆范围与检索。'],
      activity: ['主动互动', '决定猫猫何时接话、何时主动来找你。'],
      diagnostics: ['诊断', '按渠道检查收件、模型处理、投递和媒体下载。'],
    };
    const draftDestination = (key) => key.startsWith('channels:peer:') ? { view: 'activity', activityTab: 'groups' }
      : key === 'memory:sharing' ? { view: 'activity', activityTab: 'sharing' }
      : key.startsWith('models:credentials:') ? { view: 'models', modelTab: 'credentials' }
      : key.startsWith('models:') ? { view: 'models', modelTab: key.slice(7) }
      : key.startsWith('personas:') ? { view: 'personas', personaTab: 'library' }
      : key.startsWith('memory:learning') ? { view: 'memory', memoryTab: 'learning' }
      : key.startsWith('memory:') ? { view: 'memory', memoryTab: 'settings' }
      : { view: 'channels', platform: 'qq', channelTab: 'bindings' };
    function Subnav({ label, value, options, onChange, dirty = () => false }) {
      return h('nav', { 'aria-label': label, className: 'maomao-subnav' },
        options.map(([id, title]) => h('button', { key: id, type: 'button', 'aria-pressed': value === id,
          className: value === id ? 'selected' : '', onClick: () => onChange(id) }, title,
          dirty(id) && h('span', { className: 'maomao-draft-dot', title: '未保存' }, ' · 未保存'))));
    }
    function Disclosure({ title, initial = false, forceOpen = false, children }) {
      const [expanded, setOpen] = useState(initial);
      const open = forceOpen || expanded;
      return h('div', { style: stackStyle },
        h('button', { type: 'button', className: 'maomao-disclosure', 'aria-expanded': open,
          onClick: () => setOpen(!open) }, `${open ? '▾' : '▸'} ${title}`),
        h('div', { hidden: !open }, children));
    }
    const panelCss = `
      .maomao-panel { container-type:inline-size; font-size:var(--maomao-font-body); line-height:1.55;
        --maomao-font-title:20px; --maomao-font-lead:16px; --maomao-font-headline:14px; --maomao-font-body:13px; --maomao-font-caption:12px;
        --maomao-accent:#7a62c9; --maomao-tint:rgba(139,115,210,.14); --maomao-danger:#c4372d; --maomao-warn:#b8791f; }
      /* Form controls follow the host theme instead of the browser default black text. */
      .maomao-panel h2 { font-size:var(--maomao-font-title); font-weight:600; line-height:1.3; }
      .maomao-panel h3 { font-size:var(--maomao-font-headline); font-weight:600; line-height:1.35; }
      .maomao-panel h4 { font-size:var(--maomao-font-body); font-weight:600; }
      .maomao-panel strong, .maomao-panel b, .maomao-panel th { font-weight:600; }
      .maomao-panel .maomao-lead { font-size:var(--maomao-font-lead); font-weight:600; line-height:1.35; }
      .maomao-panel input, .maomao-panel select, .maomao-panel textarea { color:inherit; font:inherit; }
      .maomao-panel option { color:CanvasText; background-color:Canvas; }
      /* !important: these buttons also carry the shared inline control style. */
      .maomao-panel button.maomao-primary:not(:disabled) { background:var(--maomao-accent) !important; color:#fff; border-color:transparent !important; font-weight:600; }
      .maomao-panel button.maomao-destructive { border-color:var(--maomao-danger) !important; background:rgba(196,55,45,.1) !important; }
      .maomao-panel button.maomao-destructive.maomao-confirm:not(:disabled) { background:var(--maomao-danger) !important; color:#fff; border-color:transparent !important; font-weight:600; }
      .maomao-panel .maomao-unsaved { font-weight:600; color:var(--maomao-warn); }
      .maomao-panel summary { cursor:pointer; padding:4px 0; }
      .maomao-terminal { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: var(--maomao-font-caption); line-height: 1.5;
        background: #111418; color: #d7dde5; border-radius: 10px; padding: 10px 12px; max-height: 60vh; overflow: auto; overflow-wrap: anywhere; }
      .maomao-terminal pre { white-space: pre-wrap; margin: 4px 0 4px 16px; color: #aab4c0; font: inherit; }
      .maomao-terminal summary { padding: 0; display: inline; color: #aab4c0; }
      .maomao-log-time { color: #7d8794; } .maomao-log-source { color: #8fb3ff; } .maomao-log-detail { color: #aab4c0; }
      .maomao-log-level { display: inline-block; min-width: 2.5em; font-weight: 600; }
      .maomao-log-error .maomao-log-level { color: #ff7a72; } .maomao-log-warn .maomao-log-level { color: #f0b45a; }
      .maomao-log-info .maomao-log-level { color: #7fd18b; } .maomao-log-debug .maomao-log-level { color: #8fb3ff; } .maomao-log-trace .maomao-log-level { color: #b49cf0; }
      .maomao-sticker-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,180px),1fr)); gap:12px; }
      .maomao-sticker { display:grid; gap:6px; align-content:start; border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.25)); border-radius:12px; padding:10px; overflow-wrap:anywhere; }
      .maomao-sticker img, .maomao-sticker-missing { width:100%; aspect-ratio:1; object-fit:contain; border-radius:8px; background:var(--maomao-tint); }
      .maomao-sticker-missing { display:grid; place-items:center; font-size:var(--maomao-font-caption); opacity:.72; }
      .maomao-panel .maomao-disclosure { border:0; background:transparent; padding:4px 0; text-align:left; font-weight:600; color:var(--maomao-accent); width:fit-content; }
      .maomao-panel *, .maomao-panel *::before, .maomao-panel *::after { box-sizing:border-box; }
      .maomao-panel [hidden] { display:none !important; }
      .maomao-panel button { cursor:pointer; color:inherit; font:inherit; }
      .maomao-panel button:disabled { cursor:default; opacity:.5; }
      .maomao-panel button:focus-visible, .maomao-panel input:focus-visible,
      .maomao-panel select:focus-visible, .maomao-panel textarea:focus-visible { outline:2px solid var(--maomao-accent); outline-offset:3px; }
      .maomao-panel textarea { width:100%; resize:vertical; line-height:1.65; }
      .maomao-panel select { min-width:0; text-overflow:ellipsis; }
      .maomao-layout { display:grid; grid-template-columns:142px minmax(0,1fr); gap:24px; align-items:start; }
      .maomao-nav { display:grid; gap:18px; position:sticky; top:8px; }
      .maomao-nav-group { display:grid; gap:4px; }
      .maomao-nav-label { font-size:var(--maomao-font-caption); opacity:.72; padding:0 10px 3px; }
      .maomao-nav button { border:0; background:transparent; border-radius:9px; text-align:left; padding:9px 10px; font-size:var(--maomao-font-body); }
      .maomao-nav button.selected { background:var(--maomao-tint); font-weight:600; }
      .maomao-nav button:hover, .maomao-subnav button:hover { background:rgba(139,115,210,.09); }
      .maomao-subnav { display:flex; flex-wrap:wrap; gap:4px; border-bottom:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.25)); padding-bottom:9px; }
      .maomao-subnav button { font-size:var(--maomao-font-body); border:0; border-radius:7px; padding:6px 10px; background:transparent; }
      .maomao-subnav button.selected { background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12)); font-weight:600; }
      .maomao-draft-dot { color:var(--maomao-warn); font-size:var(--maomao-font-caption); }
      .maomao-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); gap:10px; }
      .maomao-channels { grid-template-columns:repeat(3,minmax(0,1fr)); }
      @container (max-width:420px) { .maomao-channels { grid-template-columns:minmax(0,1fr); } }
      .maomao-channel { border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.25)); border-radius:12px; padding:13px; text-align:left; background:transparent; display:grid; gap:5px; }
      .maomao-channel.selected { border-color:var(--maomao-accent); background:rgba(139,115,210,.08); }
      .maomao-status { display:inline-flex; gap:6px; align-items:center; font-size:var(--maomao-font-caption); }
      .maomao-status::before { content:''; width:6px; height:6px; border-radius:50%; background:#999; }
      .maomao-status.ready::before { background:#53a47c; }
      .maomao-status.waiting::before { background:#c18b38; }
      .maomao-main { display:grid; gap:16px; min-width:0; }
      .maomao-binding { display:grid; gap:8px; padding:12px 0; border-bottom:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.2)); }
      @container (max-width:700px) {
        .maomao-layout { grid-template-columns:minmax(0,1fr); gap:18px; }
        .maomao-nav { position:static; display:flex; gap:4px; flex-wrap:wrap; }
        .maomao-nav-group { display:contents; }
        .maomao-nav-label { display:none; }
        .maomao-nav button { padding:7px 9px; }
      }
    `;

    const ownerSummary = ({ id, label, channels }) =>
      `${label} · ${channels.map((key) => destinations[key]).join('、')} · ${id.slice(-6)}`;

    function createDrafts() {
      let values = {};
      const listeners = new Set();
      function write(key, value) {
        if (values[key] === value) return;
        values = { ...values };
        if (value === undefined) delete values[key];
        else values[key] = value;
        for (const listener of listeners) listener();
      }
      return {
        read: () => values,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        write,
        clear(key, expected) { if (values[key] === expected) write(key, undefined); },
      };
    }

    function useDraft(store, key) {
      const value = useSyncExternalStore(store.subscribe, () => store.read()[key]);
      return [value, (next) => store.write(key, next), () => store.clear(key, value)];
    }

    function ChannelWizard({ snapshot, invoke, onChange, platform }) {
      const setup = snapshot.channelSetup[platform];
      const [mode, setMode] = useState('import');
      const [brand, setBrand] = useState(setup.brand);
      const [account, setAccount] = useState('');
      const [secret, setSecret] = useState('');
      const [exclusive, setExclusive] = useState(false);
      const [job, setJob] = useState(null);
      const [sending, setSending] = useState(false);
      const busy = sending || activeConnection(job);
      const ready = snapshot.channels[platform] === 'ready';
      const jobId = activeConnection(job) ? job.id : null;

      useEffect(() => {
        if (!setup.available) return;
        const abort = new AbortController();
        invoke('channelSetup', { request: { platform, action: 'current' } }, abort.signal).then((current) => {
          if (!abort.signal.aborted && current) setJob((previous) => previous ?? current);
        }).catch(() => undefined);
        return () => abort.abort();
      }, [platform, invoke, setup.available]);

      useEffect(() => {
        if (!jobId) return;
        const abort = new AbortController();
        let timer;
        async function poll() {
          try {
            const next = await invoke('channelSetup', { request: { platform, action: 'read', id: jobId } }, abort.signal);
            if (abort.signal.aborted) return;
            setJob(next);
            if (activeConnection(next)) timer = setTimeout(poll, 1000);
            else if (['connected', 'disconnected'].includes(next.state)) onChange();
          } catch {
            if (!abort.signal.aborted) setJob({ state: 'failed', reason: 'configuration_unavailable' });
          }
        }
        timer = setTimeout(poll, 350);
        return () => { abort.abort(); clearTimeout(timer); };
      }, [jobId, platform, invoke, onChange]);

      async function submit(action) {
        setSending(true);
        try {
          const next = await invoke('channelSetup', { request: { platform, action, id: job?.id, mode, brand,
            accountId: account.trim(), secret: secret.trim(), exclusive } });
          setJob(next);
          if (action === 'start') setSecret('');
          if (['connected', 'disconnected'].includes(next.state)) onChange();
        } catch { setJob({ state: 'failed', reason: 'configuration_unavailable' }); }
        finally { setSending(false); }
      }
      const needsSecret = mode === 'import' || platform === 'telegram';
      const consoleLink = brand === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app';
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 9, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, '连接 Bot'),
        h('div', { style: lineStyle },
          platform === 'feishu' && h('select', { 'aria-label': '飞书版本', value: brand, style: inputStyle,
            disabled: busy, onChange: (event) => setBrand(event.target.value) },
          h('option', { value: 'feishu' }, '飞书'), h('option', { value: 'lark' }, 'Lark')),
          h('span', null, states[snapshot.channels[platform]])),
        setup.managed && h('div', { style: lineStyle },
          button(setup.enabled ? '断开连接' : '重新连接', () => submit(setup.enabled ? 'disable' : 'enable'),
            busy || (!setup.enabled && !exclusive)),
          button('验证已保存的凭据', () => submit('test'), busy)),
        setup.managed && !setup.enabled && h('label', { style: lineStyle }, h('input', { type: 'checkbox', checked: exclusive,
          disabled: busy, onChange: (event) => setExclusive(event.target.checked) }), '确认没有其他实例连接这个 Bot'),
        setup.available ? h(Disclosure, { key: `${platform}:${setup.managed}`, title: setup.managed ? '更换 Bot 或重新授权' : '配置连接', initial: !setup.managed, forceOpen: activeConnection(job) },
        h('div', { style: { display: 'grid', gap: 12 } },
          h('div', { style: lineStyle },
            h('select', { 'aria-label': '连接方式', value: mode, style: inputStyle, disabled: busy,
              onChange: (event) => { setMode(event.target.value); setSecret(''); } },
            h('option', { value: 'import' }, '导入已有 Bot'),
            h('option', { value: 'scan' }, platform === 'telegram' ? '用管理 Bot 扫码创建' : '扫码授权')),
            mode === 'import' && platform !== 'telegram' && h('input', {
              'aria-label': 'Bot App ID', placeholder: 'App ID', value: account, style: inputStyle,
              disabled: busy, onChange: (event) => setAccount(event.target.value),
            }),
            needsSecret && h('input', { type: 'password', autoComplete: 'off', spellCheck: false,
              'aria-label': platform === 'telegram' ? 'Telegram Bot Token' : 'Bot App Secret',
              placeholder: platform === 'telegram' ? mode === 'scan' ? '管理 Bot Token' : 'Bot Token' : 'App Secret',
              value: secret, style: inputStyle, disabled: busy, onChange: (event) => setSecret(event.target.value),
            })),
          platform === 'telegram' && h('a', { href: 'https://t.me/BotFather', target: '_blank', rel: 'noreferrer' },
            mode === 'scan' ? '在 BotFather 开启管理 Bot 模式' : '在 BotFather 创建 Bot 或获取 Token'),
          h('label', { style: lineStyle }, h('input', { type: 'checkbox', checked: exclusive, disabled: busy,
            onChange: (event) => setExclusive(event.target.checked) }), '这是独立测试 Bot，或旧实例已经停止连接。'),
          h('div', { style: lineStyle },
            button(mode === 'scan' ? '生成授权二维码' : '验证并连接', () => submit('start'),
              busy || !exclusive || (needsSecret && !secret.trim()) ||
              (mode === 'import' && platform !== 'telegram' && !account.trim()), 'primary'),
            activeConnection(job) && job.state !== 'saving' && button('取消授权', () => submit('cancel'), sending)),
          job?.qr && h('div', { style: { display: 'grid', gap: 6, justifyItems: 'start' } },
            job.qr.image && h('img', { alt: '平台授权二维码', width: 210, height: 210, src: job.qr.image }),
            h('a', { href: job.qr.url, target: '_blank', rel: 'noreferrer' },
              job.qr.step === 'create' ? '打开 Telegram 创建 Bot' : '打开平台授权链接')),
          platform === 'feishu' &&
            h('a', { href: consoleLink, target: '_blank', rel: 'noreferrer' }, '在平台检查机器人权限、长连接事件和版本发布')))
          : h('p', { style: { margin: 0 } }, connectionErrors.setup_missing),
        job && h('p', { role: 'status', style: { margin: 0 } },
            job.state === 'failed' ? (connectionErrors[job.reason] ?? '连接操作失败。') : connectionLabels[job.state]));
    }

    function BindingControls({ snapshot, invoke, onBound, platform, relink, closeRelink }) {
      const other = platform === 'feishu' ? 'telegram' : 'feishu';
      const owners = snapshot.bindings.private.filter((item) =>
        !relink || (item.id !== relink.ownerId && item.channels.includes(other)));
      const [owner, setOwner] = useState(null);
      const [scope, setScope] = useState('group');
      const [pairing, setPairing] = useState(null);
      const [proof, setProof] = useState('');
      const [pending, setPending] = useState(false);
      const [restoring, setRestoring] = useState(true);
      const [notice, setNotice] = useState('');
      const [copied, setCopied] = useState(false);
      const online = snapshot.channels[platform] === 'ready';
      const ownerChoice = (owner === '' && !relink) || owners.some((item) => item.id === owner);
      const needsOwnerChoice = platform !== 'qq' && (Boolean(relink) || owners.length > 0);
      const pairingId = pairing?.id;
      const requestedRelink = pairing ? Boolean(pairing.bindingId) : Boolean(relink);
      const requestedScope = pairing?.scope ?? scope;
      useEffect(() => {
        const abort = new AbortController();
        invoke('pair', { request: { platform, action: 'current' } }, abort.signal).then((result) => {
          if (!abort.signal.aborted && result.command) {
            setPairing(result);
            if (result.scope) setScope(result.scope);
            setOwner(result.owner ?? '');
          }
        }).catch(() => {
          if (!abort.signal.aborted) setNotice('没能读取正在进行的配对，请刷新重试。');
        }).finally(() => {
          if (!abort.signal.aborted) setRestoring(false);
        });
        return () => abort.abort();
      }, [invoke, platform]);
      useEffect(() => {
        if (!pairingId || pending) return;
        const abort = new AbortController();
        let timer;
        async function poll() {
          try {
            const result = await invoke('pair', { request: { platform, action: 'read', id: pairingId } }, abort.signal);
            if (abort.signal.aborted) return;
            if (!result.command) {
              setPairing((current) => current?.id === pairingId ? null : current);
              if (result.status === 'expired') setNotice(pairingLabels.expired);
              return;
            }
            setPairing((current) => current?.id === pairingId ? result : current);
          } catch { /* keep the form while the connection recovers */ }
          if (!abort.signal.aborted) timer = setTimeout(poll, 1200);
        }
        timer = setTimeout(poll, 600);
        return () => { abort.abort(); clearTimeout(timer); };
      }, [invoke, platform, pairingId, pending]);
      async function pair(action) {
        setPending(true);
        setNotice('');
        try {
          if (action === 'start' && needsOwnerChoice && !ownerChoice) return;
          const request = action === 'start' ? { action, platform, scope, owner: platform === 'qq' ? (scope === 'c2c' ? owner ?? '' : '') : (owner ?? ''),
            ...(relink ? { bindingId: relink.id } : {}) } : { action, platform, id: pairingId, proof: proof.trim().toLowerCase() };
          const result = await invoke('pair', { request });
          if (action === 'start' && (result.command || result.status === 'busy')) {
            const current = result.command ? result : await invoke('pair', { request: { platform, action: 'current' } });
            if (current.command) setPairing(current);
            else setNotice(pairingLabels.busy);
            setProof('');
            setCopied(false);
            return;
          }
          if (['bound', 'reassigned', 'cancelled', 'expired', 'locked', 'already_bound', 'binding_changed'].includes(result.status)) {
            setPairing(null);
            setProof('');
            setOwner(null);
          }
          if (['bound', 'reassigned'].includes(result.status)) onBound(result.route);
          if (relink && result.status === 'cancelled') closeRelink();
          setNotice(pairingLabels[result.status] ?? '配对失败，请重试。');
        } catch { setNotice('连接器未能处理请求，请刷新重试。'); }
        finally { setPending(false); }
      }
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 9, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, requestedRelink
          ? `将 ${destinations[platform]} 私聊关联到同一主人` : pairingTitles[platform]),
        requestedRelink && h('p', { style: { margin: 0 } },
          '确认后，这个私聊将使用所选主人的普通记忆，并开启新的会话上下文。原记忆保留在原档案中。'),
        online && h('div', { style: lineStyle },
          !pairing && (platform === 'qq'
            ? h('select', { 'aria-label': 'QQ 会话类型', value: scope, style: inputStyle, disabled: Boolean(pairing) || pending,
              onChange: (event) => setScope(event.target.value) },
            h('option', { value: 'group' }, 'QQ群白名单'), h('option', { value: 'c2c' }, 'QQ 私聊'),
            h('option', { value: 'owner' }, 'QQ群主人身份'))
            : needsOwnerChoice && h('select', { 'aria-label': '主人及记忆归属', value: ownerChoice ? owner || 'new' : 'choose', style: inputStyle,
              disabled: pending, onChange: (event) => setOwner(event.target.value === 'new' ? '' : event.target.value) },
            h('option', { value: 'choose', disabled: true }, relink ? '选择要关联的主人' : '这个私聊是谁？'),
            !relink && h('option', { value: 'new' }, '新的主人 · 记忆单独记'),
            owners.map((item) => h('option', { key: item.id, value: item.id }, `同一位主人 · ${ownerSummary(item)}`)))),
          // A QQ private chat can share identity and memory with an existing Lark / Telegram owner.
          platform === 'qq' && requestedScope === 'c2c' && owners.length > 0 && h('select', { 'aria-label': '这个 QQ 私聊是谁', value: owner ?? '', style: inputStyle,
            disabled: Boolean(pairing) || pending, onChange: (event) => setOwner(event.target.value) },
          h('option', { value: '' }, '不关联主人 · 这个 QQ 私聊单独记'),
          owners.map((item) => h('option', { key: item.id, value: item.id }, `同一位主人 · ${ownerSummary(item)}`))),
          !pairing && button(relink ? '生成关联指令' : '生成配对指令', () => pair('start'),
            restoring || pending || (needsOwnerChoice && !ownerChoice), 'primary'),
          relink && !pairing && button('返回', closeRelink, pending)),
        online && !pairing && needsOwnerChoice && !relink && h('p', { style: { margin: 0 } },
          '选同一位主人后，猫猫会认出这是同一个人；开启「私聊记忆共享」时，各渠道记得的是同一份事。新的主人单独记。'),
        !online && !pairing && h('p', { style: { margin: 0 } }, '完成上一步，等 Bot 显示「已连接」后即可配对。'),
        pairing && h('div', { style: { display: 'grid', gap: 8 } },
          platform !== 'qq' && h('p', { style: { margin: 0 } }, pairing.owner
            ? `本次关联：${snapshot.bindings.private.find((item) => item.id === pairing.owner)?.label ?? '所选主人'}`
            : '本次绑定为新的主人，记忆单独记。'),
          h('p', { style: { margin: 0 } }, pairing.link ? '打开 Telegram，点击开始以验证这个私聊。' : platform === 'qq' && requestedScope !== 'c2c'
            ? (requestedScope === 'owner' ? '由要绑定的主人在已加入白名单的 QQ 群 @猫猫，发送下面的指令。' : '在目标 QQ 群 @猫猫，发送下面的指令。')
            : '把下面的指令发给这个渠道的猫猫私聊。'),
          h('div', { style: lineStyle },
            pairing.link && h('a', { href: pairing.link, target: '_blank', rel: 'noreferrer' }, '打开 Telegram 配对'),
            h('code', { style: { overflowWrap: 'anywhere', minWidth: 0 } }, pairing.command),
            button(copied ? '已复制' : '复制指令', async () => {
              try { await navigator.clipboard.writeText(pairing.command); setCopied(true); }
              catch { setNotice('请手动复制配对指令。'); }
            })),
          h('p', { role: 'status', style: { margin: 0 } }, pairing.delivery === 'sent'
            ? '平台已接受确认码消息。请回到聊天窗口查看。' : pairing.delivery === 'failed'
              ? '已收到配对指令，但确认码发送失败。检查 Bot 发消息的权限后，取消并重新生成。'
              : pairing.status === 'claimed' ? '已收到配对指令，正在发送确认码…'
                : '正在等待配对指令。若没有进度，请确认发给了正确的 Bot，QQ 群内需要 @ 它。'),
          h('p', { style: { margin: 0 } }, `输入 8 个字符（数字或 a–f）。剩余约 ${Math.max(0, Math.ceil((pairing.expires - Date.now()) / 1000))} 秒。`),
          h('div', { style: lineStyle },
            h('input', { 'aria-label': '配对确认码', style: { ...inputStyle, width: 145 }, value: proof,
              placeholder: '8 字符确认码', autoComplete: 'off', spellCheck: false, maxLength: 8,
              onChange: (event) => setProof(event.target.value) }),
            button(requestedRelink ? '确认关联' : '确认绑定', () => pair('confirm'), pending || !/^[a-f0-9]{8}$/i.test(proof.trim()), 'primary'),
            button('取消', () => pair('cancel'), pending))),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice));
    }

    function OwnerName({ owner, invoke, onChange }) {
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      async function save(event) {
        event.preventDefault();
        setBusy(true);
        setNotice('');
        try {
          const result = await invoke('renameOwner', { request: { owner: owner.id, label: editing } });
          if (result.status === 'saved') { setEditing(null); onChange(); }
          else setNotice('昵称未保存。请使用最多 32 个字符，或留空恢复默认名称。');
        } catch { setNotice('昵称保存失败，请重试。'); }
        finally { setBusy(false); }
      }
      return h('div', { style: { display: 'grid', gap: 5 } },
        h('div', { style: lineStyle },
          h('span', null, ownerSummary(owner)),
          editing === null && button('改昵称', () => { setEditing(owner.nickname ?? ''); setNotice(''); })),
        editing !== null && h('form', { style: lineStyle, onSubmit: save },
          h('input', { 'aria-label': '主人昵称', placeholder: '留空恢复默认名称', maxLength: 32,
            style: inputStyle, value: editing, disabled: busy, onChange: (event) => setEditing(event.target.value) }),
          h('button', { type: 'submit', style: inputStyle, disabled: busy }, '保存昵称'),
          button('取消', () => { setEditing(null); setNotice(''); }, busy)),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice));
    }

    function BindingManagement({ entries = [], owners, platform, invoke, onChange, canRelink, onRelink }) {
      const [selected, setSelected] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      async function remove(route) {
        setBusy(true);
        try {
          const result = await invoke('unbind', { request: { platform: route.platform, id: route.id } });
          if (result.status === 'unbound') { setNotice('已解绑。'); onChange(); }
          else setNotice('绑定已变更，请刷新。');
        } catch { setNotice('解绑失败，请重试。'); }
        finally { setSelected(null); setBusy(false); }
      }
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 8, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, '管理已绑定会话'),
        h('p', { style: { margin: 0 } }, `这里只显示 ${destinations[platform]} 的绑定。配对决定谁能和猫猫聊天；主人身份决定猫猫怎么称呼对方、私聊记忆记在谁名下。`),
        entries.length === 0 && h('p', { style: { margin: 0 } }, '暂无面板绑定。'),
        ...entries.map((route) => h('div', { key: route.id, className: 'maomao-binding' },
          h('span', null, `${destinations[route.platform]} · ${route.platform === 'qq'
            ? ({ group: '群白名单', c2c: '私聊白名单', owner: '群主人身份' }[route.scope] ?? '会话')
            : owners.find((owner) => owner.id === route.ownerId)?.label ?? `主人 ${route.owner}`}`,
          ` · ${(route.groupOpenId ?? route.userOpenId ?? route.id).slice(-8)}`,
          route.privateOwner ? ` · 关联主人 ${owners.find((owner) => owner.id === route.privateOwner)?.label ?? route.privateOwner.slice(-6)}（私聊记忆跟随这位主人）` : ''),
          h('details', null, h('summary', { style: { cursor: 'pointer', opacity: 0.7 } }, '查看完整标识'),
            h('code', { style: { overflowWrap: 'anywhere', display: 'block', fontSize: type.caption } }, route.groupOpenId ? `群 OpenID：${route.groupOpenId}`
              : route.userOpenId ? `用户 OpenID：${route.userOpenId}` : `绑定 ID：${route.id}`)),
          h('div', { style: lineStyle }, selected === route.id
            ? h(ReactFragment, null, button('确认解绑', () => remove(route), busy, 'confirmDestructive'),
              button('取消解绑', () => setSelected(null), busy))
            : h(ReactFragment, null,
              canRelink(route) && button('关联同一主人', () => onRelink(route), busy),
              button('解绑', () => { setNotice(''); setSelected(route.id); }, busy, 'destructive'))))),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice),
        owners.some(owner => owner.channels.includes(platform)) && h(ReactFragment, null,
          h('h4', { style: { margin: '8px 0 0' } }, '私聊主人与记忆归属'),
          ...owners.filter(owner => owner.channels.includes(platform)).map((owner) => h(OwnerName, { key: owner.id, owner, invoke, onChange }))));
    }

    function QqDirectMessages({ settings, online, invoke, onChange, drafts }) {
      const [draft, setDraft, clearDraft] = useDraft(drafts, 'channels:qq-direct-messages');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const value = draft ?? { acceptStrangers: settings.acceptStrangers === true };
      async function save() {
        setBusy(true);
        try {
          const result = await invoke('qqDirectMessageSettings', { request: value });
          if (result.status === 'saved') { clearDraft(); onChange(); }
          setNotice(result.status === 'saved' ? '私聊设置已保存，立即生效。' : '未能保存，请确认 QQ 连接器正在运行。');
        } catch { setNotice('保存失败，请重试。'); }
        finally { setBusy(false); }
      }
      const inbound = settings.lastInbound;
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 8, ...(draft ? unsavedStyle : {}) } },
        h('h3', { style: { margin: 0 } }, 'QQ 私聊'),
        h('label', { style: lineStyle }, h('input', { type: 'checkbox', checked: value.acceptStrangers,
          disabled: busy || !online, onChange: (event) => setDraft(event.target.checked === settings.acceptStrangers ? undefined : { acceptStrangers: event.target.checked }) }), '接受陌生人私聊'),
        h('p', { style: { margin: 0, fontSize: type.body } }, value.acceptStrangers
          ? '开启后，未配对用户也能直接聊天并调用已启用的聊天工具，会产生模型用量。每个人使用独立的 QQ 私聊记忆，不会获得主人身份。'
          : '关闭时，仅已配对或加入私聊白名单的用户可以聊天。未配对用户仍可发送 /sid 查询身份、/pair 查看配对步骤。'),
        h('p', { style: { margin: 0, fontSize: type.body } }, '指定用户可通过「添加绑定 → QQ 私聊」配对。若这里仍开启，解绑后对方仍能作为陌生人聊天。'),
        h('p', { role: 'status', style: { margin: 0, fontSize: type.body } }, inbound
          ? `最近私聊收件：${inbound.outcome === 'admitted' ? '已准入' : '等待配对'} · ${timestamp(inbound.at)}`
          : '本次启动后尚未收到私聊消息。若 /sid 没有回复，请确认发给了当前 Bot，以及 QQ 平台已开放单聊消息能力。'),
        h('div', { style: lineStyle }, button('保存私聊设置', save, busy || !online || !draft),
          draft && button('取消修改', clearDraft, busy)),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice));
    }

    function QqPeerSettings({ groups, invoke, onChange, drafts }) {
      const [selected, select] = useState('');
      const group = groups.find(({ id }) => id === selected) ?? groups[0];
      if (!group) return null;
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 8 } },
        h('h3', { style: { margin: 0 } }, 'QQ 群互动'),
        h('label', { style: lineStyle }, '选择群聊', h('select', { style: inputStyle, value: group.id,
          onChange: (event) => select(event.target.value) },
        groups.map(({ id, label }) => h('option', { key: id, value: id }, label)))),
        h(QqPeerGroup, { key: group.id, group, invoke, onChange, drafts }));
    }

    function QqPeerGroup({ group, invoke, onChange, drafts }) {
      const [draft, setDraft, clearDraft] = useDraft(drafts, `channels:peer:${group.id}`);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const value = draft ?? group;
      const update = (key, next) => setDraft({ ...value, [key]: next });
      async function save() {
        setBusy(true);
        try {
          const result = await invoke('qqPeerSettings', { request: value });
          if (result.status === 'saved') { clearDraft(); onChange(); }
          setNotice(result.status === 'saved' ? '已保存。'
            : result.status === 'invalid' ? '请检查轮数设置。' : '当前群设置不可用。');
        } catch { setNotice('保存失败，请重试。'); }
        finally { setBusy(false); }
      }
      return h('div', { style: { display: 'grid', gap: 8 } },
        h('p', { style: { margin: 0 } }, '模型会参考同群上下文和已启用的 QQ 普通记忆，判断是否接群里的话。'),
        h('label', { style: lineStyle }, h('input', { type: 'checkbox', checked: value.enabled,
          disabled: busy, onChange: (event) => update('enabled', event.target.checked) }), '启用群互动'),
        h('label', { style: lineStyle }, '多人一起聊时，和其他机器人最多接几轮',
          h('select', { value: value.maxRounds, style: draft ? unsavedStyle : inputStyle, disabled: busy,
            onChange: (event) => update('maxRounds', Number(event.target.value)) },
          [1, 2, 3, 4, 5].map((n) => h('option', { key: n, value: n }, n)))),
        // The two-round cap for a single human audience is fixed in code; say so next to the setting.
        h('p', { style: mutedStyle }, `只有一个人在看两个机器人斗嘴时，固定最多接 ${Math.min(2, value.maxRounds)} 轮；最近 5 分钟有至少两个人说话时，才按这里的 ${value.maxRounds} 轮。`),
        h('label', { style: lineStyle }, h('input', { type: 'checkbox', checked: value.paused,
          disabled: busy, onChange: (event) => update('paused', event.target.checked) }), '暂停互动'),
        h('p', { style: { margin: 0 } }, '群友可用 /停止互动 立即暂停。群主人可用 /恢复互动，或在这里取消暂停。'),
        h('div', { style: lineStyle }, button('保存群互动设置', save, busy || !draft),
          draft && button('取消修改', clearDraft, busy)),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice));
    }

    const replyCheckLabels = {
      waiting: '等待收到这条测试消息…', received: '已收到，正在等猫猫生成回复…',
      sending: '模型已回复，正在投递到聊天窗口…', sent: '平台已接受猫猫的回复，请到聊天窗口确认。',
      no_message: '没有收到测试消息。请核对 Bot 和已绑定会话，再生成一条测试消息。',
      model_failed: '已收到消息，但模型调用失败。请测试当前对话模型。',
      model_empty: '已收到消息，但模型没有返回文字。请测试当前对话模型。',
      delivery_failed: '模型已回复，但平台投递未成功。请检查 Bot 发消息的权限。',
      interrupted: '处理已中断。请确认会话仍已绑定、人格设置已保存，再试一次。',
      processing_timeout: '已经收件，但处理超时。请检查对话模型和渠道连接。',
      replies_disabled: '已经收件，但此 QQ Bot 的直接回复已关闭。请检查连接器的回复设置。',
      unavailable: '这个会话暂时无法测试。请确认 Bot 在线、会话仍已绑定。',
      busy: '这个渠道还有一条测试正在处理，请等它完成。',
    };
    const replyInProgress = (status) => ['waiting', 'received', 'sending'].includes(status);

    function FirstReply({ platform, snapshot, invoke, preferred, openModels }) {
      const targets = snapshot.bindings.managed.filter((route) => route.platform === platform && route.scope !== 'owner');
      const [selected, setSelected] = useState('');
      const [check, setCheck] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const target = [selected, replyInProgress(check?.status) && check.route, preferred, check?.route, targets[0]?.id]
        .find((id) => targets.some((route) => route.id === id));
      const checkText = check?.route === target ? check?.text : '';
      const checkStatus = check?.route === target ? check?.status : null;
      const ready = snapshot.channels[platform] === 'ready';
      const hasTargets = targets.length > 0;
      useEffect(() => {
        if (busy || !hasTargets) return;
        const abort = new AbortController();
        let timer;
        async function read() {
          try {
            const result = await invoke('replyCheck', { request: { platform, action: 'read' } }, abort.signal);
            if (abort.signal.aborted) return;
            setCheck(result);
            setNotice((previous) => previous === '暂时无法读取测试状态，正在重试。' ? '' : previous);
            if (!replyInProgress(result.status)) return;
          } catch {
            if (!abort.signal.aborted) setNotice('暂时无法读取测试状态，正在重试。');
          }
          if (!abort.signal.aborted) timer = setTimeout(read, 1200);
        }
        void read();
        return () => { abort.abort(); clearTimeout(timer); };
      }, [platform, invoke, busy, hasTargets]);
      async function start() {
        setBusy(true);
        setNotice('');
        try {
          const next = await invoke('replyCheck', { request: { action: 'start', platform, route: target } });
          if (next.status === 'waiting') setCheck(next);
          else setNotice(replyCheckLabels[next.status] ?? replyCheckLabels.unavailable);
        } catch { setNotice('没能开始测试，请刷新重试。'); }
        finally { setBusy(false); }
      }
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 8, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, '验证聊天回复'),
        h('div', { style: lineStyle },
          h('span', null, ready ? 'Bot 已在线' : '等待 Bot 在线'),
          h('span', null, target ? '· 已有绑定会话' : '· 等待绑定会话')),
        target && h('div', { style: lineStyle },
          targets.length > 1 && h('select', { 'aria-label': '测试会话', style: inputStyle,
            disabled: busy, value: target, onChange: (event) => { setNotice(''); setSelected(event.target.value); } },
          targets.map((route) => h('option', { key: route.id, value: route.id }, platform === 'qq'
            ? `${route.scope === 'group' ? 'QQ群' : 'QQ 会话'} · ${(route.groupOpenId ?? route.userOpenId ?? route.id).slice(-8)}`
            : `${snapshot.bindings.private.find((owner) => owner.id === route.ownerId)?.label ?? `主人 ${route.owner}`} · ${route.id.slice(-8)}`))),
          button(checkText ? '生成新的测试消息' : '生成测试消息', start,
            busy || !ready || ['received', 'sending'].includes(check?.status))),
        checkText && checkStatus === 'waiting' && h('div', { style: { display: 'grid', gap: 6 } },
          h('p', { style: { margin: 0 } }, platform === 'qq' && targets.find((route) => route.id === target)?.scope !== 'c2c'
            ? '到选中的 QQ 群 @猫猫，发送下面整句。' : '到选中的私聊，发送下面整句。'),
          h('div', { style: lineStyle }, h('code', { style: { overflowWrap: 'anywhere' } }, checkText),
            button('复制测试消息', async () => {
              try { await navigator.clipboard.writeText(checkText); setNotice('已复制。'); }
              catch { setNotice('请手动复制测试消息。'); }
            }))),
        h('p', { role: 'status', style: { margin: 0 } },
          replyCheckLabels[checkStatus] ?? (target ? '用一条带编号的消息核对收件、模型和投递。' : '先绑定一个私聊或 QQ 群，再来验证聊天。')),
        ['model_failed', 'model_empty', 'processing_timeout'].includes(checkStatus)
          && h('div', null, button('检查对话模型', openModels)),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice));
    }

    function ChannelCards({ snapshot, selected, onSelect }) {
      return h('div', { className: 'maomao-grid maomao-channels' }, platforms.map(platform => {
        const count = snapshot.bindings.managed.filter(route => route.platform === platform && route.scope !== 'owner').length;
        const state = snapshot.channels[platform];
        return h('button', { key: platform, type: 'button', className: `maomao-channel${selected === platform ? ' selected' : ''}`,
          'aria-pressed': selected === platform, onClick: () => onSelect(platform) },
          h('strong', { style: { fontSize: type.headline, fontWeight: 600 } }, destinations[platform]),
          h('span', { className: `maomao-status ${state}` }, states[state]),
          h('span', { style: { opacity: 0.72, fontSize: type.caption } }, count ? `${count} 个已绑定会话` : '尚未绑定会话'));
      }));
    }

    function QuickStart({ snapshot, openChannel, go }) {
      const connected = platforms.filter(p => snapshot.channels[p] === 'ready').length;
      const bound = snapshot.bindings.managed.filter(route => route.scope !== 'owner').length;
      return h('div', { style: stackStyle },
        h('section', { style: { ...sectionStyle, display: 'grid', gap: 8 } },
          h('h3', { className: 'maomao-lead', style: { margin: 0 } }, connected ? `${connected} 个渠道在线 · ${bound} 个聊天已绑定` : '先选一个聊天入口'),
          h('p', { style: mutedStyle }, connected ? '日常调整从导航进入。新增平台时，只需完成连接、配对和回复验证。'
            : '只在 DSH 桌面聊天，无需绑定 Bot；想在聊天软件里使用，就先连接一个渠道。'),
          h('div', { style: lineStyle }, button('查看人设', () => go({ view: 'personas', personaTab: 'library' })),
            button('选择对话模型', () => go({ view: 'models', modelTab: 'chat' })))),
        h(ChannelCards, { snapshot, onSelect: openChannel }),
        h('div', { className: 'maomao-grid' },
          h('section', { style: { ...sectionStyle, display: 'grid', gap: 8 } },
            h('h3', { style: { margin: 0 } }, '记忆'),
            h('p', { style: mutedStyle }, `私聊记忆${snapshot.memory.private ? '已开启' : '未开启'} · QQ 记忆${snapshot.memory.qq ? '已开启' : '未开启'}`),
            button('看看猫猫记住了什么', () => go({ view: 'memory', memoryTab: 'library' }))),
          h('section', { style: { ...sectionStyle, display: 'grid', gap: 8 } },
            h('h3', { style: { margin: 0 } }, '主动互动'),
            h('p', { style: mutedStyle }, `私聊主动分享：${modes[snapshot.sharing.mode]}`),
            button('调整接话与分享', () => go({ view: 'activity' })))),
        h('details', null, h('summary', { style: { cursor: 'pointer' } }, '第一次使用？查看接入顺序'),
          h('ol', { style: { paddingLeft: 22, display: 'grid', gap: 8 } },
            h('li', null, '桌面聊天：新建 DSH 会话，在模式中选择「猫猫」。'),
            h('li', null, '聊天平台：连接 Bot → 绑定群或私聊 → 测试回复。'),
            h('li', null, '基础聊天可用后，再按需配置识图、生图、语音、记忆与主动互动。'))));
    }

    function SharePreview({ invoke }) {
      const [state, setState] = useState({});
      async function preview() {
        setState({ pending: true });
        try { setState({ result: await invoke('previewShare') }); }
        catch { setState({ result: { reason: 'failed' } }); }
      }
      const result = state.result;
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 8, fontSize: type.body } },
        h('div', { style: lineStyle }, button(state.pending ? '正在试跑…' : '主动分享试跑', preview, state.pending),
          h('span', null, '按当前规则选内容，试跑不发消息。')),
        result && h('div', { role: 'status', style: { display: 'grid', gap: 4, overflowWrap: 'anywhere' } },
          result.status === 'shadow'
            ? [h('strong', { key: 'source' }, result.source === 'lonely' ? '候选：寂寞小猫' : '候选：后台浏览'),
              h('span', { key: 'text' }, result.text), result.url && h('span', { key: 'url' }, result.url)]
            : previewLabels[result.reason] ?? '暂不满足发送条件。'));
    }

    const mediaProviders = { dsh: 'DSH 已配置的模型', google: 'Google', openai: 'OpenAI', openrouter: 'OpenRouter' };

    function ChatModels({ invoke, drafts }) {
      const [catalog, setCatalog] = useState(null);
      const [draftChoice, setChoice, clearChoice] = useDraft(drafts, 'models:chat');
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const key = (model) => JSON.stringify([model.provider, model.model]);
      useEffect(() => {
        const cancel = new AbortController();
        invoke('chatModel', { request: { action: 'list' } }, cancel.signal).then((value) => {
          if (cancel.signal.aborted) return;
          setCatalog(value);
        }).catch(() => {
          if (!cancel.signal.aborted) setResult({ status: 'unavailable' });
        });
        return () => cancel.abort();
      }, [invoke]);
      async function submit(action) {
        const selected = catalog.choices.find((model) => key(model) === choice);
        if (choice && !selected) return;
        const selection = selected ? { provider: selected.provider, model: selected.model } : { inherit: true };
        setBusy(true);
        setResult(null);
        try {
          const next = await invoke('chatModel', { request: { action, selection } });
          setResult(next);
          if (next.status === 'saved') {
            setCatalog((previous) => ({ ...previous, saved: selection }));
            clearChoice();
          }
        } catch { setResult({ status: action === 'test' ? 'test_failed' : 'save_failed' }); }
        finally { setBusy(false); }
      }
      const messages = { invalid: '模型不可用或不支持文本对话。', unavailable: '当前无法读取 Harness 模型目录。',
        saved: '已保存。猫猫下一条对话会使用这项设置。', test_failed: '模型测试失败。请检查模型凭据和额度。',
        save_failed: '保存失败，先前的模型设置已保留。' };
      const groups = Map.groupBy(catalog?.choices ?? [], (model) => model.provider);
      const savedChoice = catalog?.saved && !catalog.saved.inherit ? key(catalog.saved) : '';
      const choice = draftChoice ?? savedChoice;
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 9, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, '对话模型 · 基础聊天'),
        h('p', { style: { margin: 0 } }, '渠道文字聊天只需要一个可用的对话模型。默认跟随 DSH，也可以为猫猫单独选择。'),
        catalog && h('p', { style: { margin: 0 } }, catalog.saved && !catalog.saved.inherit
          ? `已保存：${catalog.saved.provider} / ${catalog.saved.model}`
          : catalog.default ? `当前跟随 DSH：${catalog.default.model}` : 'DSH 暂无可用默认模型，请先到 DSH 的「设置 → 模型」添加。'),
        catalog ? h('div', { style: lineStyle },
          h('select', { 'aria-label': '猫猫对话模型', style: inputStyle, value: choice, disabled: busy,
            onChange: (event) => { setChoice(event.target.value === savedChoice ? undefined : event.target.value); setResult(null); } },
          h('option', { value: '' }, catalog.default ? `跟随 DSH（${catalog.default.model}）` : '跟随 DSH 默认模型'),
          choice && !catalog.choices.some((model) => key(model) === choice) &&
            h('option', { value: choice }, '先前选择的模型当前不可用'),
          [...groups].map(([provider, models]) => h('optgroup', { key: provider, label: mediaProviders[provider] ?? provider },
            models.map((model) => h('option', { key: key(model), value: key(model) }, model.name))))),
          button('测试对话模型', () => submit('test'), busy || (!choice && !catalog.default)),
          saveControl('保存对话模型', () => submit('save'), busy || !catalog.available || (!choice && !catalog.default) || choice === savedChoice, choice !== savedChoice))
          : !result && h('p', { role: 'status', style: { margin: 0 } }, '正在读取 Harness 模型目录…'),
        busy && h('p', { role: 'status', style: { margin: 0 } }, '正在处理模型设置…'),
        result && h('p', { role: 'status', style: { margin: 0, overflowWrap: 'anywhere' } },
          result.status === 'tested' ? `测试通过 · ${result.text}` : messages[result.status]));
    }

    const mediaRoles = { vision: '识图模型', image: '生图模型', voice: '语音模型', embedding: 'Embedding 模型' };
    const mediaUse = {
      vision: '用于 Lark / 飞书、Telegram 和 QQ 的聊天图片识别。',
      image: '由模型在 QQ、Lark / 飞书、Telegram 对话中调用，生成并发送图片。',
      voice: '由模型根据上下文选择语音回复。Lark / 飞书和 Telegram 需要本机安装 FFmpeg。',
      embedding: '用于私聊记忆向量检索，也可配合 QQ 记忆和表情库各自的开关。',
    };
    const mediaMessages = { invalid: '配置无效。', unavailable: '对应的模型服务未加载。', saved: '已保存，后续消息使用此设置。',
      test_failed: '模型未返回有效的测试结果，请检查凭据、权限和额度。', save_failed: '保存失败，原设置仍保留。',
      credential_missing: '请先到「模型与能力 → 服务凭据」配置该服务的 API Key。', credential_saved: '凭据已保存在 Harness 凭据库。',
      credential_rejected: '服务拒绝了当前凭据，请换一个有效的 API Key。', rate_limit: '服务暂时限流，请稍后重试。' };

    function MediaModelCard({ entry, voices, invoke, onChange, drafts }) {
      const { role, saved } = entry;
      // Vision lists DSH-routed models (including "follow the chat model") ahead of the direct provider presets.
      const groups = entry.dshModels?.length ? [{ provider: 'dsh', models: entry.dshModels }, ...entry.groups] : entry.groups;
      const label = (provider, model) => (provider === 'dsh' && entry.labels?.[model]) || model;
      const [persisted, setPersisted] = useState(() => {
        const provider = saved?.provider ?? groups.find((group) => group.models.includes(saved?.model))?.provider
          ?? (saved?.model?.match(/^(?:gpt-|chatgpt-image-)/i) ? 'openai' : groups[0].provider);
        return { provider, model: saved?.model ?? groups[0].models[0], enabled: saved?.enabled ?? false,
          ...(role === 'voice' ? { voice: saved?.voice ?? voices[0] } : {}) };
      });
      const [storedDraft, setDraft, clearDraft] = useDraft(drafts, `models:${role}`);
      const selection = storedDraft ?? persisted;
      const [manual, setManual] = useState(role !== 'embedding' && !groups.some((group) =>
        group.provider === selection.provider && group.models.includes(selection.model)));
      const [discovery, setDiscovery] = useState(null);
      const { voice, enabled } = selection;
      const [busy, setBusy] = useState('');
      const [result, setResult] = useState(null);
      const draft = { provider: selection.provider, model: selection.model.trim(), enabled,
        ...(role === 'voice' ? { voice } : {}) };
      const dirty = storedDraft !== undefined;
      const update = (fields) => {
        const next = { ...selection, ...fields };
        setDraft(Object.keys(persisted).some((key) => next[key] !== persisted[key]) ? next : undefined);
        setResult(null);
      };
      const options = groups.map(({ provider, models }) => {
        const live = discovery?.find((group) => group.provider === provider);
        const values = new Set(live?.status === 'ok' ? live.models : [...models, ...(live?.models ?? [])]);
        if (provider === persisted.provider) values.add(persisted.model);
        if (provider === selection.provider && selection.model) values.add(selection.model);
        return { provider, models: [...values] };
      });
      async function discover() {
        setBusy('discover');
        setResult(null);
        try {
          const response = await invoke('mediaModel', { request: { role, action: 'discover' } });
          setDiscovery(response.status === 'ok' ? response.groups : null);
          if (response.status !== 'ok') setResult({ status: 'test_failed' });
        } catch { setResult({ status: 'test_failed' }); }
        finally { setBusy(''); }
      }
      async function submit(action) {
        setBusy(action);
        setResult(null);
        try {
          const next = await invoke('mediaModel', { request: { role, action, selection: draft } });
          setResult(next);
          if (next.status === 'saved') { setPersisted(draft); clearDraft(); onChange(); }
        } catch { setResult({ status: action === 'test' ? 'test_failed' : 'save_failed' }); }
        finally { setBusy(''); }
      }
      const preview = result?.data && ['image/jpeg', 'image/png', 'image/webp', 'audio/wav'].includes(result.mime)
        ? `data:${result.mime};base64,${result.data}` : null;
      const title = mediaRoles[role];
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 9, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, title),
        h('p', { style: { margin: 0 } }, mediaUse[role]),
        role === 'vision' && entry.chatVision && h('div', { role: 'status', style: { display: 'grid', gap: 6 } },
          entry.chatVision.sees
            ? h('p', { style: { margin: 0 } }, `当前对话模型「${entry.chatVision.name}」可以直接看图，推荐选「跟随对话模型」：聊天里的图片直接交给它看，表情收藏也用它，不需要单独的识图模型和密钥。`)
            : h('p', { style: { margin: 0 } }, `当前对话模型「${entry.chatVision.name || '未设置'}」不能看图，需要另选一个支持图片的识图模型。`),
          entry.chatVision.sees && !(selection.provider === 'dsh' && selection.model === 'chat' && selection.enabled)
            && h('div', null, button('使用推荐：跟随对话模型', () => { setManual(false); update({ provider: 'dsh', model: 'chat', enabled: true }); }, !!busy, 'primary'))),
        h('div', { style: lineStyle },
          manual ? h(ReactFragment, null,
            h('select', { 'aria-label': `${title}服务商`, style: inputStyle, value: selection.provider, disabled: !!busy,
              onChange: (event) => update({ provider: event.target.value, model: '' }) },
            groups.filter(({ provider }) => provider !== 'dsh').map(({ provider }) => h('option', { key: provider, value: provider }, mediaProviders[provider]))),
            h('input', { 'aria-label': `${title} ID`, style: inputStyle, value: selection.model, maxLength: 135,
              placeholder: '填写官方模型 ID', disabled: !!busy,
              onChange: (event) => update({ model: event.target.value }) }))
            : h('select', { 'aria-label': title, style: inputStyle,
              value: JSON.stringify([selection.provider, selection.model]), disabled: !!busy,
              onChange: (event) => {
                const [provider, model] = JSON.parse(event.target.value);
                update({ provider, model });
              } },
            options.map(({ provider, models }) => h('optgroup', { key: provider, label: mediaProviders[provider] },
              models.map((model) => h('option', { key: model, value: JSON.stringify([provider, model]) }, label(provider, model)))))),
          role === 'voice' && h('select', { 'aria-label': '语音音色', style: inputStyle, value: voice, disabled: !!busy,
            onChange: (event) => update({ voice: event.target.value }) },
          voices.map((value) => h('option', { key: value, value }, value))),
          h('label', { style: lineStyle }, h('input', { type: 'checkbox', checked: enabled, disabled: !!busy,
            onChange: (event) => update({ enabled: event.target.checked }) }), `启用${title}`)),
        h('div', { style: lineStyle }, button(`刷新${title}列表`, discover, !!busy),
          role !== 'embedding' && button(manual ? '从列表选择' : '手动填写', () => {
            if (manual && !selection.model.trim()) update({ provider: groups[0].provider, model: groups[0].models[0] });
            setManual(!manual); setResult(null);
          }, !!busy),
          button(role === 'voice' ? '生成试听' : `测试${title}`, () => submit('test'), !!busy || !selection.model.trim()),
          saveControl(`保存${title}`, () => submit('save'), !!busy || !draft.model || !dirty, dirty)),
        discovery && h('p', { role: 'status', style: { margin: 0 } }, discovery.map(({ provider, status, models }) =>
          `${mediaProviders[provider]} ${status === 'ok' || status === 'partial'
            ? `找到 ${models.length} 个候选${status === 'partial' ? '（列表不完整）' : ''}`
            : status === 'credential_missing' ? '未配置凭据' : '列表读取失败，仍可使用预设'}`).join(' · ')),
        discovery && role === 'embedding' && h('p', { style: { margin: 0 } }, '仅列出当前向量索引支持的模型。'),
        busy && h('p', { role: 'status', style: { margin: 0 } }, busy === 'discover' ? '正在读取服务商模型列表…'
          : busy === 'test' ? '正在用固定样例测试…' : '正在保存…'),
        result && h('p', { role: 'status', style: { margin: 0, overflowWrap: 'anywhere' } },
          result.status === 'tested' ? `测试通过${result.text ? ` · ${result.text}`
            : result.dimensions ? ` · ${result.dimensions} 维` : ''}` : mediaMessages[result.status]),
        preview && (role === 'voice' ? h('audio', { controls: true, src: preview, 'aria-label': '语音模型试听' })
          : h('img', { src: preview, alt: '生图模型测试预览', style: { width: '100%', maxWidth: 240, borderRadius: 8 } })));
    }

    function MediaCredential({ provider, configured, source, writable, invoke, refresh, drafts }) {
      const [secretDraft, setSecret, clearSecret] = useDraft(drafts, `models:credentials:${provider}`);
      const secret = secretDraft ?? '';
      const [result, setResult] = useState('');
      const [busy, setBusy] = useState(false);
      const label = { google: 'Google Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' }[provider];
      async function save() {
        setBusy(true);
        try {
          const value = await invoke('mediaModel', { request: { action: 'credential', provider, secret: secret.trim() } });
          setResult(value.status);
          if (value.status === 'credential_saved') { clearSecret(); refresh(); }
        } catch { setResult('save_failed'); }
        finally { setBusy(false); }
      }
      return h('div', { style: { display: 'grid', gap: 5 } },
        h('div', { style: lineStyle }, h('span', null, `${label} · ${source === 'harness' ? '复用 DSH 凭据'
          : source === 'maomao' ? '使用猫猫专用凭据' : configured ? '已配置' : '未配置'}`),
          h('input', { 'aria-label': `${label} API Key`, type: 'password', autoComplete: 'off', style: inputStyle,
            value: secret, onChange: (event) => setSecret(event.target.value || undefined), disabled: !writable || busy }),
          saveControl(`保存 ${label} 凭据`, save, !writable || busy || !secret.trim(), !!secret.trim())),
        result && h('p', { role: 'status', style: { margin: 0 } }, mediaMessages[result]));
    }

    function MediaModels({ invoke, onChange, drafts, selected }) {
      const [catalog, setCatalog] = useState(null);
      const [failed, setFailed] = useState(false);
      const refresh = useCallback(() => {
        invoke('mediaModel', { request: { action: 'list' } }).then(setCatalog).catch(() => setFailed(true));
      }, [invoke]);
      useEffect(refresh, [refresh]);
      if (!catalog) return h('p', { role: 'status' }, failed ? '模型配置读取失败。' : '正在读取媒体模型设置…');
      return h(ReactFragment, null,
        selected === 'credentials' && h('section', { style: { ...sectionStyle, display: 'grid', gap: 9, fontSize: type.body } },
          h('h3', { style: { margin: 0 } }, '模型服务凭据'),
          ...Object.keys(catalog.credentials).map((provider) => h(MediaCredential, { key: provider,
            provider, configured: catalog.credentials[provider], source: catalog.credentialSources?.[provider],
            writable: catalog.writable, invoke, refresh, drafts })),
          h('p', { style: { margin: 0 } }, '已配置的 DSH 凭据会自动复用；只在需要单独使用其他账号时填写。未保存的输入仅暂存在本次运行内存中，退出 DSH 后清除。')),
        ...catalog.entries.filter(entry => entry.role === selected).map((entry) => h(MediaModelCard, { key: entry.role, entry, voices: catalog.voices, invoke, onChange, drafts })));
    }

    function WebSettings({ invoke, drafts }) {
      const [value, setValue] = useState(null);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [secretDraft, setSecret, clearSecret] = useDraft(drafts, 'models:web:credential');
      const secret = secretDraft ?? '';
      const refresh = useCallback(() => invoke('webSettings', { request: { action: 'read' } }).then(setValue), [invoke]);
      useEffect(() => { refresh().catch(() => setMessage('读取联网设置失败。')); }, [refresh]);
      async function act(request) {
        setBusy(true); setMessage('');
        try {
          const result = await invoke('webSettings', { request });
          if (result.status === 'saved' && request.action === 'credential') clearSecret();
          setMessage(result.message ?? (result.status === 'tested'
            ? `测试成功${result.title ? `：${result.title}` : ''}${result.sources?.length ? `，返回 ${result.sources.length} 条来源` : ''}。`
            : result.status === 'saved' ? '已保存。' : result.status === 'empty' ? '请求完成，但没有搜索结果。' : '操作未成功。'));
          await refresh();
        } catch { setMessage('操作未成功，请刷新后重试。'); }
        finally { setBusy(false); }
      }
      if (!value) return h('p', { role: 'status' }, message || '正在读取联网设置…');
      return h('div', { style: stackStyle },
        h('section', { style: { ...sectionStyle, ...stackStyle } },
          h('strong', null, '公共信息搜索'),
          h('p', { style: mutedStyle }, `当前提供商：${value.searchProvider ?? '未就绪'}。网页读取：${value.fetchProvider ?? '未就绪'}。搜索与对话模型分别配置。`),
          h('div', { style: lineStyle }, h('span', null, value.deepseekCredential ? 'DeepSeek 官方密钥已配置' : 'DeepSeek 官方密钥未配置'),
            h('input', { type: 'password', autoComplete: 'off', 'aria-label': 'DeepSeek 搜索 API Key', style: inputStyle,
              value: secret, disabled: busy, placeholder: '填入后保存到 DSH 凭据库', onChange: event => setSecret(event.target.value || undefined) }),
            saveControl('保存 DeepSeek 凭据', () => act({ action: 'credential', secret: secret.trim() }), busy || !secret.trim(), !!secret.trim())),
          h('p', { style: mutedStyle }, '复用 DSH 的 DEEPSEEK_API_KEY，不改变对话模型。搜索只使用必要的公共关键词；网页内容不会作为指令。'),
          button('测试当前搜索', () => act({ action: 'test_search' }), busy)),
        h('section', { style: { ...sectionStyle, ...stackStyle } },
          h('strong', null, '公开网页浏览器'),
          h('p', { style: mutedStyle }, '猫猫可按需阅读动态网页、跟随页面链接和查看截图。只访问公开 HTTPS 页面，不使用你的个人浏览器登录状态，不操作表单。每轮对话独立，结束后清理。'),
          h('p', { style: { margin: 0 } }, `${value.browser.installed ? '已找到 Chrome / Edge' : '未找到 Chrome / Edge'} · ${value.browser.running ? '浏览器运行中' : '需要时启动'} · ${value.browser.active} 个使用中的环境`),
          h('div', { style: lineStyle },
            button(value.browser.enabled ? '关闭浏览器能力' : '开启浏览器能力', () => act({ action: 'browser', enabled: !value.browser.enabled }), busy),
            button('测试网页读取', () => act({ action: 'test_browser' }), busy || !value.browser.enabled || !value.browser.installed))),
        message && h('p', { role: 'status', 'aria-live': 'polite' }, message));
    }

    function EmbeddingIndex({ invoke }) {
      const [value, setValue] = useState(null);
      const [busy, setBusy] = useState(false);
      const poll = useCallback(async (action = 'read') => {
        try { setValue(await invoke('embeddingIndex', { request: { action } })); }
        catch { setValue({ status: 'failed' }); }
      }, [invoke]);
      useEffect(() => { void poll(); }, [poll]);
      useEffect(() => {
        if (value?.status !== 'running') return;
        const timer = setInterval(() => { void poll(); }, 2500);
        return () => clearInterval(timer);
      }, [value?.status, poll]);
      async function command(action) {
        setBusy(true);
        await poll(action);
        setBusy(false);
      }
      const messages = { disabled: '在「模型与能力 → 向量检索」启用后可重建索引。', no_bindings: '猫猫还没有记住任何内容。',
        failed: '重建中断，已写入的向量保留，可重试。', cancelled: '已取消，已写入的向量保留。',
        running: '正在重建…', done: '重建完成。', ready: '当前向量索引' };
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 9, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, '记忆向量索引'),
        h('p', { style: { margin: 0 } }, '覆盖「自主学习」里猫猫记住的内容（各渠道），让她按意思也能找回旧记忆。新记住的内容会自动加入；换了 Embedding 模型后点重建。重建会把这些记忆发给选定的 Embedding 服务，期间仍可按关键词检索。'),
        value && h('p', { role: 'status', style: { margin: 0 } }, messages[value.status],
          Number.isInteger(value.total) && ` · ${value.indexed}/${value.total}`),
        h('div', { style: lineStyle }, button('重建向量索引', () => command('start'),
          busy || !value || ['disabled', 'no_bindings', 'running'].includes(value.status)),
          value?.status === 'running' && button('取消重建', () => command('cancel'), busy)));
    }

    const preferenceMessages = { saved: '已保存。', invalid: '请检查设置后重试。', needs_consent: '定时发送需要先勾选「我确认允许猫猫向所选私聊主动发消息」。',
      unavailable: '对应的渠道插件未加载。', destination_missing: '目标已不可用，请重新选择已验证的私聊。',
      save_failed: '保存失败，原设置仍保留。' };

    function PreferenceCard({ title, section, initial, invoke, onChange, children, drafts }) {
      const [persisted, setPersisted] = useState(initial);
      const [draft, setDraft, clearDraft] = useDraft(drafts, `memory:${section}`);
      const [sendConfirmed, setSendConfirmed] = useState(initial.sendConfirmed === true);
      const [state, setState] = useState('');
      const value = { ...persisted, ...draft, ...(section === 'sharing' ? { sendConfirmed } : {}) };
      // The consent belongs to one recipient: it stays for the saved one and is asked again for a new one.
      const confirmedFor = (next) => persisted.sendConfirmed === true && next.mode === persisted.mode && next.target === persisted.target;
      const set = (key, next) => {
        if (key === 'sendConfirmed') setSendConfirmed(next);
        else {
          const changes = { ...draft, [key]: next };
          if (next === persisted[key]) delete changes[key];
          setDraft(Object.keys(changes).length ? changes : undefined);
          if (key === 'target' || key === 'mode') setSendConfirmed(confirmedFor({ ...persisted, ...changes }));
        }
        setState('');
      };
      const consentChanged = section === 'sharing' && sendConfirmed !== (persisted.sendConfirmed === true);
      const dirty = draft !== undefined || consentChanged;
      async function save() {
        if (section === 'sharing' && value.mode === 'send' && !sendConfirmed) { setState('needs_consent'); return; }
        setState('saving');
        try {
          const result = await invoke('memorySettings', { request: { action: 'save', section, value } });
          setState(result.status);
          if (result.status === 'saved') {
            setPersisted({ ...value, sendConfirmed: section === 'sharing' && value.mode === 'send' && sendConfirmed });
            clearDraft();
            onChange();
          }
        } catch { setState('save_failed'); }
      }
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 9, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, title),
        children(value, set, state === 'saving'),
        saveControl(`保存${title}`, save, !initial.available || state === 'saving' || !dirty, dirty),
        state && h('p', { role: 'status', style: { margin: 0 } },
          state === 'saving' ? '正在保存…' : preferenceMessages[state]));
    }

    function MemorySettings({ invoke, onChange, drafts, section = 'memory' }) {
      const [settings, setSettings] = useState(null);
      const [failed, setFailed] = useState(false);
      useEffect(() => {
        const abort = new AbortController();
        invoke('memorySettings', { request: { action: 'list' } }, abort.signal).then((result) => {
          if (!abort.signal.aborted) setSettings(result);
        }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
        return () => abort.abort();
      }, [invoke]);
      if (!settings) return h('p', { role: 'status' }, failed ? '设置读取失败。' : '正在读取记忆与分享设置…');
      const checkbox = (label, checked, set, disabled) => h('label', { style: lineStyle },
        h('input', { type: 'checkbox', checked, disabled, onChange: (event) => set(event.target.checked) }), label);
      return h(ReactFragment, null,
        section === 'memory' && h(PreferenceCard, { title: '私聊记忆', section: 'privateMemory', initial: settings.privateMemory, invoke, onChange, drafts },
          (value, set, busy) => h(ReactFragment, null,
            checkbox('启用普通私聊记忆', value.enabled, (checked) => set('enabled', checked), busy),
            checkbox('同一位主人的私聊共享记忆：飞书 / Lark、Telegram 和已关联主人的 QQ 私聊', value.shared, (checked) => set('shared', checked), busy || !value.enabled),
            h('p', { style: { margin: 0 } }, '先在「渠道与会话」把这些私聊绑定到同一位主人。关闭后各渠道分开记，已经共享的记忆不会被删除。'))),
        section === 'memory' && h(PreferenceCard, { title: 'QQ 群与未关联私聊的记忆', section: 'qqMemory', initial: settings.qqMemory, invoke, onChange, drafts },
          (value, set, busy) => h(ReactFragment, null,
            checkbox('启用 QQ 群与未关联私聊的记忆', value.enabled, (checked) => set('enabled', checked), busy),
            h('p', { style: { margin: 0 } }, '每个 QQ 群、每个没关联主人的 QQ 私聊各记各的，不会进入主人的共享记忆。'),
            checkbox('在启用 QQ 表情库时使用 Embedding 检索', value.stickerEmbedding,
              (checked) => set('stickerEmbedding', checked), busy))),
        section === 'sharing' && h(PreferenceCard, { title: '主动分享设置', section: 'sharing', initial: settings.sharing, invoke, onChange, drafts },
          (value, set, busy) => h(ReactFragment, null,
            h('div', { style: lineStyle },
              h('select', { 'aria-label': '主动分享模式', value: value.mode, style: inputStyle, disabled: busy,
                onChange: (event) => set('mode', event.target.value) },
              h('option', { value: 'off' }, '关闭'), h('option', { value: 'shadow' }, '模拟运行'),
              h('option', { value: 'send' }, '定时发送'),
              value.mode === 'manual' && h('option', { value: 'manual', disabled: true }, '原配置：仅手动')),
              h('select', { 'aria-label': '主动分享目标', value: value.target, style: inputStyle,
                disabled: busy || value.mode === 'off', onChange: (event) => set('target', event.target.value) },
              h('option', { value: '' }, '选择已验证的私聊'),
              value.targets.map((target) => h('option', { key: target.id, value: target.id },
                `${destinations[target.platform]} · ${target.label ?? `主人 ${target.owner}`} · ${target.id.slice(-8)}`)))),
            !value.targets.length && h('p', { style: { margin: 0 } }, '配对后先在目标私聊发一条普通消息，即可在这里选中。'),
            checkbox('寂寞小猫', value.lonely, (checked) => set('lonely', checked), busy),
            checkbox('后台浏览', value.browse, (checked) => set('browse', checked), busy),
            h('div', { style: lineStyle }, h('span', null, '免打扰时段（台北时间）'),
              ...['quietStart', 'quietEnd'].map((key) => h('label', { key, style: lineStyle },
                key === 'quietStart' ? '开始' : '结束',
                h('input', { type: 'number', min: 0, max: 23, step: 1, style: { ...inputStyle, width: 70 },
                  'aria-label': key === 'quietStart' ? '免打扰开始小时' : '免打扰结束小时',
                  value: value[key], disabled: busy,
                  onChange: (event) => set(key, event.target.value === '' ? '' : Number(event.target.value)) })))),
            value.mode === 'send' && checkbox('我确认允许猫猫向所选私聊主动发消息', value.sendConfirmed === true,
              (checked) => set('sendConfirmed', checked), busy),
            h('p', { style: { margin: 0 } }, '开始和结束相同时全天免打扰。启用后，目标私聊发一条消息即可启动计时。'))));
    }

    const learningKinds = { profile: '对象档案', episode: '经历与待办', skill: '可复用技能', style: '语气与互动习惯', meme: '梗知识', followup: '惦记的事', diary: '猫猫日记' };
    const learningPlatforms = { desktop: '桌面', private: '私聊', 'private-shared': '主人私聊共享', qq: 'QQ', feishu: 'Lark / 飞书', telegram: 'Telegram' };
    const learningTtl = { episode: 30, followup: 14, diary: 60 };
    const learningResults = { saved: '已保存', failed: '操作失败，请重试', conflict: '这条内容刚有更新，请刷新后再修改',
      invalid: '内容或参数不符合要求', missing: '这条内容已不可用', unavailable: '学习服务尚未就绪', forgotten: '已遗忘，请从版本记录恢复' };
    function LearningView({ invoke, drafts }) {
      const [catalog, setCatalog] = useState(null);
      const [filters, setFilters] = useState({ sourceId: '', kind: '', query: '', page: 0 });
      const [query, setQuery] = useState('');
      const [result, setResult] = useState(null);
      const [refresh, setRefresh] = useState(0);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [history, setHistory] = useState(null);
      const [confirmation, setConfirmation] = useState(null);
      const [settingsDraft, setSettingsDraft, clearSettings] = useDraft(drafts, 'memory:learning-settings');
      const [edit, setEdit, clearEdit] = useDraft(drafts, 'memory:learning-edit');
      useEffect(() => {
        const cancel = new AbortController();
        invoke('learning', { request: { action: 'list' } }, cancel.signal).then(value => {
          if (cancel.signal.aborted) return;
          if (value.status !== 'ok') { setNotice(learningResults[value.status] ?? '读取失败'); return; }
          setCatalog(value);
          setFilters(previous => ({ ...previous, sourceId: previous.sourceId || value.sources[0]?.id || '' }));
        }).catch(() => { if (!cancel.signal.aborted) setNotice('读取失败，请刷新'); });
        return () => cancel.abort();
      }, [invoke, refresh]);
      useEffect(() => {
        setResult(null); setHistory(null); setConfirmation(null);
        if (!filters.sourceId) return;
        const cancel = new AbortController();
        invoke('learning', { request: { action: 'read', ...filters } }, cancel.signal).then(value => {
          if (!cancel.signal.aborted) setResult(value);
        }).catch(() => { if (!cancel.signal.aborted) setResult({ status: 'failed' }); });
        return () => cancel.abort();
      }, [invoke, filters, refresh]);
      async function act(request) {
        setBusy(true); setNotice('');
        try {
          const value = await invoke('learning', { request });
          setNotice(learningResults[value.status] ?? (value.status === 'ok' ? '' : '操作失败'));
          if (value.status === 'saved') { setRefresh(n => n + 1); setConfirmation(null); }
          return value;
        } catch { setNotice('操作失败，请重试'); return { status: 'failed' }; }
        finally { setBusy(false); }
      }
      async function download(id) {
        const value = await act({ action: 'export', sourceId: filters.sourceId, ...(id ? { id } : {}) });
        if (!value.markdown) return;
        const url = URL.createObjectURL(new Blob([value.markdown], { type: 'text/markdown;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = value.filename; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      const settings = { ...catalog?.settings, ...settingsDraft };
      const setting = (key, value) => {
        const next = { ...settingsDraft, [key]: value };
        if (value === catalog.settings[key]) delete next[key];
        setSettingsDraft(Object.keys(next).length ? next : undefined);
      };
      const change = patch => setFilters(previous => ({ ...previous, ...patch, page: patch.page ?? 0 }));
      return h('div', { style: stackStyle },
        h('section', { style: { ...sectionStyle, ...stackStyle } },
          h('h3', { style: { margin: 0 } }, '猫猫学到了什么'),
          h('p', { style: { margin: 0 } }, '猫猫会从普通聊天学习记忆、语气、梗和表情搭配，按需要查询和复用。每条保留来源和最近 20 个版本。QQ 群按群分开记；同一位主人的飞书 / Lark、Telegram 和已关联的 QQ 私聊，在开启共享后合并为一份。'),
          catalog && h('div', { style: stackStyle },
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(settings.enabled), onChange: e => setting('enabled', e.target.checked) }), ' 允许自主记忆和技能复用'),
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(settings.reflection), onChange: e => setting('reflection', e.target.checked) }), ' 回复后后台总结（使用当前对话模型，产生额外调用）'),
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(settings.stickers), onChange: e => setting('stickers', e.target.checked) }), ' 允许模型调用表情包工具（QQ、Lark / 飞书、Telegram）'),
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(settings.collectStickers), onChange: e => setting('collectStickers', e.target.checked) }), ' 允许收藏收到的可复用表情（需要已启用识图）'),
            h('label', { style: lineStyle }, '每个范围每日最多总结', h('input', { type: 'number', min: 0, max: 100, style: { ...inputStyle, width: 80 },
              value: settings.dailyLimit, onChange: e => setting('dailyLimit', Number(e.target.value)) }), '次；所有范围合计最多 200 次'),
            saveControl('保存学习设置', async () => { if ((await act({ action: 'settings', ...settings })).status === 'saved') clearSettings(); }, busy || !settingsDraft, Boolean(settingsDraft))),
          notice && h('p', { role: 'status', style: { margin: 0 } }, notice)),
        edit && h('section', { style: { ...sectionStyle, ...stackStyle, borderColor: '#b8791f' } },
          h('h4', { style: { margin: 0 } }, '修正学习内容 · 未保存'),
          h('input', { 'aria-label': '经验标题', value: edit.entry.title, maxLength: 100, style: inputStyle,
            onChange: e => setEdit({ ...edit, entry: { ...edit.entry, title: e.target.value } }) }),
          h('textarea', { 'aria-label': '经验内容', value: edit.entry.body, rows: 8, maxLength: edit.entry.kind === 'skill' ? 5000 : 1000, style: inputStyle,
            onChange: e => setEdit({ ...edit, entry: { ...edit.entry, body: e.target.value } }) }),
          h('label', null, '确认程度 ', h('select', { style: inputStyle, value: edit.entry.certainty,
            onChange: e => setEdit({ ...edit, entry: { ...edit.entry, certainty: e.target.value } }) },
          h('option', { value: 'confirmed' }, '已确认'), h('option', { value: 'tentative' }, '待验证'))),
          saveControl('保存修正', async () => { if ((await act({ action: 'edit', ...edit })).status === 'saved') clearEdit(); }, busy, true), button('放弃修改', clearEdit, busy)),
        h('form', { style: lineStyle, onSubmit: e => { e.preventDefault(); change({ query }); } },
          h('select', { 'aria-label': '学习范围', style: inputStyle, value: filters.sourceId, onChange: e => change({ sourceId: e.target.value }) },
            ...(catalog?.sources ?? []).map(s => h('option', { key: s.id, value: s.id }, [s.label, learningPlatforms[s.platform] ?? s.platform].filter((part, i, all) => i === 0 || !all[0].includes(part)).join(' · ')))),
          h('select', { 'aria-label': '学习类型', style: inputStyle, value: filters.kind, onChange: e => change({ kind: e.target.value }) },
            h('option', { value: '' }, '全部类型'), ...Object.entries(learningKinds).map(([id, label]) => h('option', { key: id, value: id }, label))),
          h('input', { type: 'search', placeholder: '搜索学到的内容', 'aria-label': '搜索学习内容', style: inputStyle, value: query, maxLength: 100, onChange: e => setQuery(e.target.value) }),
          h('button', { style: inputStyle, type: 'submit' }, '搜索'), button('刷新', () => setRefresh(n => n + 1), busy),
          button('导出 MEMORY.md', () => download(), busy || !filters.sourceId)),
        !catalog?.sources?.length && h('p', null, '还没有学习记录。正常聊一会儿，或让猫猫记住一种偏好、总结刚完成的方法，再来刷新。'),
        result?.review && h('p', { style: mutedStyle }, `最近后台总结：${({ learned: '已学到新内容', no_change: '没有需要新增的经验', skipped: '本轮未学习', running: '处理中', failed: '调用失败，下次对话可再总结' })[result.review.outcome] ?? result.review.outcome} · ${timestamp(result.review.at)}`),
        result?.status === 'ok' && h('p', { role: 'status' }, `${result.total} 条记录；“待验证”的经验使用时仍需结合当前要求。`),
        result && result.status !== 'ok' && h('p', { role: 'alert' }, '学习记录读取失败，请刷新。'),
        // Speakers are stored as hashes; only distinguish them when a group scope has several.
        ...(result?.items ?? []).map((item, _i, items) => h('article', { key: item.id, style: { ...sectionStyle, ...stackStyle, overflowWrap: 'anywhere' } },
          h('strong', null, item.title),
          h('div', { style: mutedStyle }, `${learningKinds[item.kind]} · ${item.certainty === 'confirmed' ? '已确认' : '待验证'} · ${memoryStates[item.status] ?? item.status}${new Set(items.map(row => row.subject)).size > 1 ? ` · 发言者 ${[...new Set(items.map(row => row.subject))].indexOf(item.subject) + 1}` : ''} · 第 ${item.version} 版`),
          h('div', { style: { whiteSpace: 'pre-wrap' } }, item.body),
          item.quote && h('details', null, h('summary', null, '学习依据'), h('p', null, item.quote)),
          h('div', { style: mutedStyle }, `更新 ${timestamp(item.updated)} · 调用 ${item.used} 次${item.last_used ? ` · 最近使用 ${timestamp(item.last_used)}` : ''}`),
          h('div', { style: lineStyle }, button('修正', () => setEdit({ sourceId: filters.sourceId, entry: { ...item, ttlDays: learningTtl[item.kind] ?? 365 } }), busy || item.status !== 'active' || Boolean(edit)),
            button('版本记录', async () => { const value = await act({ action: 'history', sourceId: filters.sourceId, id: item.id }); setHistory({ id: item.id, items: value.items ?? [] }); }, busy),
            button('遗忘', () => setConfirmation({ item }), busy || item.status === 'forgotten', 'destructive'),
            item.kind === 'skill' && button('导出 SKILL.md', () => download(item.id), busy || item.status !== 'active')),
          confirmation?.item.id === item.id && h('div', { style: lineStyle }, '遗忘后不再召回，版本记录仍可恢复。',
            button('确认遗忘', () => act({ action: 'forget', sourceId: filters.sourceId, id: item.id, version: item.version }), busy, 'confirmDestructive'), button('取消', () => setConfirmation(null), busy)),
          history?.id === item.id && h('div', { style: stackStyle }, ...history.items.map(old => h('details', { key: old.version },
            h('summary', null, `第 ${old.version} 版 · ${timestamp(old.updated)}`), h('p', { style: { whiteSpace: 'pre-wrap' } }, old.body),
            old.version !== item.version && button(`恢复到第 ${old.version} 版`, () => act({ action: 'restore', sourceId: filters.sourceId, id: item.id, version: item.version, revision: old.version }), busy)))))),
        result?.status === 'ok' && h('div', { style: lineStyle }, button('上一页', () => change({ page: filters.page - 1 }), !filters.page || busy),
          h('span', null, `第 ${filters.page + 1} 页`), button('下一页', () => change({ page: filters.page + 1 }), (filters.page + 1) * result.pageSize >= result.total || busy)));
    }

    const memoryKinds = { preference: '偏好', project: '项目', historical_note: '旧资料' };
    // Says in plain words where a group @ stops: platform delivery, bot identity, or owner / panel state.
    const groupReasons = {
      addressed: '收到了 @ 猫猫的群消息。', not_addressed: '收到了群消息，但没有 @ 猫猫，所以不回应。',
      bot_unidentified: '收到了群消息，但 Bot 不知道自己的身份，没法判断是不是在 @ 它。',
      owner_unknown: '收到了 @，但这个群还没开启：发消息的人不是已绑定的主人。请主人先在群里 @ 猫猫一次（主人要先和猫猫私聊过）。',
      disabled: '这个群在面板里关闭了。', groups_off: '群聊功能在配置里被关闭了。', command: '以 / 开头的命令在群里不会回应。',
      accepted: '最近一次 @ 已交给猫猫回复。',
    };
    function GroupCheck({ platform, check }) {
      const lines = [];
      if (platform === 'telegram') lines.push(check.readAll === true ? ['ok', '隐私模式已关闭，群里的 @ 能收到。']
        : check.readAll === false ? ['warn', '隐私模式还开着：群里普通的 @猫猫 收不到，只有回复猫猫的消息能到。按上面的步骤关闭后，把 Bot 移出群再拉回来。']
          : ['wait', 'Bot 还没连上，暂时无法检查隐私模式。']);
      if (platform === 'feishu') lines.push(check.identified === true ? ['ok', '已识别 Bot 自己的身份，能分辨群里的 @。']
        : check.identified === false ? ['warn', '没能读取 Bot 自己的 open_id，群里的 @ 无法识别。请检查应用凭据后重新连接。']
          : ['wait', 'Bot 还没连上。']);
      lines.push(check.last ? [check.last.reason === 'addressed' ? 'ok' : 'warn', `${groupReasons[check.last.reason] ?? check.last.reason}（${timestamp(check.last.at)}）`]
        : ['warn', platform === 'feishu' ? '自 DSH 启动以来没收到任何飞书群消息：请确认 Bot 在群里、权限和事件订阅已开通并发布。'
          : '自 DSH 启动以来没收到任何 Telegram 群消息。']);
      if (check.accept) lines.push([check.accept.reason === 'accepted' ? 'ok' : 'warn', `${groupReasons[check.accept.reason] ?? check.accept.reason}（${timestamp(check.accept.at)}）`]);
      return h('div', { role: 'status', style: { display: 'grid', gap: 4 } }, h('strong', null, '检查'),
        ...lines.map(([state, text], index) => h('span', { key: index, className: `maomao-status ${state === 'ok' ? 'ready' : state === 'warn' ? 'waiting' : ''}` }, text)));
    }

    // Lark / Telegram groups. They switch on when the owner first @-mentions the cat there.
    function PrivateGroups({ invoke, platform }) {
      const [value, setValue] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      const [refresh, setRefresh] = useState(0);
      useEffect(() => {
        const cancel = new AbortController();
        invoke('privateGroups', { request: { action: 'list' } }, cancel.signal).then((next) => {
          if (!cancel.signal.aborted) setValue(next);
        }).catch(() => { if (!cancel.signal.aborted) setValue({ status: 'failed' }); });
        return () => cancel.abort();
      }, [invoke, refresh]);
      async function toggle(group) {
        setBusy(true); setNotice('');
        const status = group.status === 'enabled' ? 'disabled' : 'enabled';
        try {
          const result = await invoke('privateGroups', { request: { action: 'set', key: group.key, status } });
          setNotice(result?.status === 'saved' ? (status === 'enabled' ? '已在这个群开启。' : '已在这个群关闭，猫猫不会再回应这里的 @。') : '保存失败，请刷新后重试。');
          setRefresh((n) => n + 1);
        } catch { setNotice('保存失败，请刷新后重试。'); } finally { setBusy(false); }
      }
      const groups = (value?.groups ?? []).filter((group) => group.platform === platform);
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 8 } },
        h('h3', { style: { margin: 0 } }, '群聊'),
        h('p', { style: mutedStyle }, `把 Bot 拉进${destinations[platform]}群后，由已绑定的主人在群里 @猫猫 一次，这个群就会开启。之后群里任何人 @ 或回复猫猫，她都会接话。`
          + '群聊有独立的记忆和表情库，不会用到主人的私聊记忆，也不会收到主动分享。'),
        platform === 'telegram' && h('p', { style: mutedStyle }, 'Telegram 默认开着隐私模式，这时群里普通的 @猫猫 根本不会转给 Bot。需要在 @BotFather 发 /setprivacy → 选这个 Bot → Disable，然后把 Bot 移出群再重新拉进来。猫猫仍然只回应 @ 她或回复她的消息。'),
        platform === 'feishu' && h('p', { style: mutedStyle }, '飞书应用需要开通「获取群组中所有 @ 机器人的消息」权限（im:message.group_at_msg:readonly），事件订阅里要有「接收消息」（im.message.receive_v1），改完后发布新版本才生效。'),
        value?.status === 'ok' && value.checks?.[platform] && h(GroupCheck, { platform, check: value.checks[platform] }),
        !value && h('p', { role: 'status', style: mutedStyle }, '正在读取…'),
        value?.status === 'failed' && h('p', { role: 'alert' }, '读取群聊列表失败。'),
        value?.status === 'ok' && value.enabled === false && h('p', { role: 'status' }, '群聊功能在配置里被关闭了（groups.enabled: false）。'),
        value?.status === 'ok' && !groups.length && h('p', { style: { margin: 0 } }, '还没有开启的群。'),
        ...groups.map((group) => h('div', { key: group.key, className: 'maomao-binding' },
          h('div', { style: lineStyle }, h('strong', null, group.label),
            h('span', { className: `maomao-status ${group.status === 'enabled' ? 'ready' : ''}` }, group.status === 'enabled' ? '已开启' : '已关闭')),
          h('div', { style: { ...mutedStyle, fontSize: type.caption } }, `开启于 ${timestamp(group.added)} · 最近 @ ${timestamp(group.lastSeen)}`),
          h('div', null, button(group.status === 'enabled' ? '在这个群关闭' : '重新开启', () => toggle(group), busy,
            group.status === 'enabled' ? 'destructive' : 'primary')))),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice));
    }

    // Stickers the cat collected, one library per chat. Removing one also stops it being collected again.
    const stickerResults = { removed: '已移除，猫猫之后也不会再收藏这张。', missing: '这张表情已经不在了。', unavailable: '找不到这个表情库，请刷新。',
      invalid: '请求不符合要求。', failed: '读取表情库失败，请重试。' };
    function StickerLibrary({ invoke }) {
      const [catalog, setCatalog] = useState(null);
      const [sourceId, setSourceId] = useState('');
      const [page, setPage] = useState(0);
      const [result, setResult] = useState(null);
      const [refresh, setRefresh] = useState(0);
      const [confirm, setConfirm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState('');
      useEffect(() => {
        const cancel = new AbortController();
        invoke('stickers', { request: { action: 'list' } }, cancel.signal).then((value) => {
          if (cancel.signal.aborted) return;
          setCatalog(value);
          const sources = value?.sources ?? [];
          const preferred = sources.find((source) => source.count > 0) ?? sources[0];
          setSourceId((previous) => sources.some((source) => source.id === previous) ? previous : preferred?.id ?? '');
        }).catch(() => { if (!cancel.signal.aborted) setCatalog({ status: 'failed' }); });
        return () => cancel.abort();
      }, [invoke, refresh]);
      useEffect(() => {
        setResult(null); setConfirm(null);
        if (!sourceId) return;
        const cancel = new AbortController();
        invoke('stickers', { request: { action: 'read', sourceId, page } }, cancel.signal).then((value) => {
          if (!cancel.signal.aborted) setResult(value);
        }).catch(() => { if (!cancel.signal.aborted) setResult({ status: 'failed' }); });
        return () => cancel.abort();
      }, [invoke, sourceId, page, refresh]);
      async function remove(item) {
        setBusy(true); setNotice('');
        try {
          const value = await invoke('stickers', { request: { action: 'remove', sourceId, id: item.id } });
          setNotice(stickerResults[value?.status] ?? stickerResults.failed);
          if (value?.status === 'removed') setRefresh((n) => n + 1);
        } catch { setNotice(stickerResults.failed); } finally { setBusy(false); setConfirm(null); }
      }
      if (!catalog) return h('p', { role: 'status', style: mutedStyle }, '正在读取表情库…');
      if (catalog.status !== 'ok') return h('p', { role: 'alert' }, stickerResults.failed);
      const intro = h('p', { style: mutedStyle }, '猫猫在聊天里看到可复用、不含隐私的表情时会自己收藏，之后按语气挑着发。每个群和私聊各有一个表情库。'
        + '收藏需要在「模型与能力 → 识图」启用识图，并在「自主学习」允许收藏表情。');
      if (!catalog.sources.length) {
        return h('section', { style: { ...sectionStyle, ...stackStyle } }, h('h3', { style: { margin: 0 } }, '表情库'), intro,
          h('p', { style: { margin: 0 } }, '还没有任何表情库。猫猫第一次在某个聊天里看图后就会建立。'));
      }
      const pages = result?.status === 'ok' ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
      return h('section', { style: { ...sectionStyle, ...stackStyle } },
        h('h3', { style: { margin: 0 } }, '表情库'), intro,
        h('label', { style: lineStyle }, '查看',
          h('select', { style: inputStyle, value: sourceId, onChange: (event) => { setSourceId(event.target.value); setPage(0); setNotice(''); } },
            catalog.sources.map((source) => h('option', { key: source.id, value: source.id },
              `${source.label}${source.count === null ? '' : ` · ${source.count} 张`}`))),
          button('刷新', () => setRefresh((n) => n + 1), busy)),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice),
        !result && h('p', { role: 'status', style: mutedStyle }, '正在读取…'),
        result && result.status !== 'ok' && h('p', { role: 'alert' }, stickerResults[result.status] ?? stickerResults.failed),
        result?.status === 'ok' && result.total === 0 && h('p', { style: mutedStyle }, '这个聊天还没有收藏的表情。'),
        result?.status === 'ok' && result.total > 0 && h('div', { className: 'maomao-sticker-grid' },
          result.items.map((item) => h('article', { key: item.id, className: 'maomao-sticker' },
            item.image ? h('img', { src: item.image, alt: item.description, loading: 'lazy' })
              : h('div', { className: 'maomao-sticker-missing' }, '图片过大或缺失'),
            h('strong', null, item.description),
            h('div', { style: { ...mutedStyle, fontSize: type.caption } }, [item.category, item.text && `图中文字：${item.text}`]
              .filter(Boolean).join(' · ')),
            item.reason && h('div', { style: { fontSize: type.caption } }, `适合：${item.reason}`),
            h('div', { style: { ...mutedStyle, fontSize: type.caption } }, `收藏于 ${timestamp(item.collected)}${item.lastSent ? ` · 最近发送 ${timestamp(item.lastSent)}` : ''}`),
            confirm === item.id
              ? h('div', { style: lineStyle }, button('确认移除', () => remove(item), busy, 'confirmDestructive'), button('取消', () => setConfirm(null), busy))
              : h('div', null, button('移除', () => { setConfirm(item.id); setNotice(''); }, busy, 'destructive'))))),
        result?.status === 'ok' && pages > 1 && h('div', { style: lineStyle },
          button('上一页', () => setPage(page - 1), busy || page === 0),
          h('span', null, `第 ${page + 1} / ${pages} 页`),
          button('下一页', () => setPage(page + 1), busy || page + 1 >= pages)));
    }

    const memoryStates = { active: '有效', expired: '已过期', superseded: '已更新', archived: '已归档', forgotten: '已遗忘' };

    function PersonaSettings({ invoke, revision, drafts, section }) {
      const [data, setData] = useState(null);
      const [editedId, setEditedId] = useState('maomao');
      const [storedDraft, setDraft, clearDraft] = useDraft(drafts, 'personas:editor');
      const [targetId, setTargetId] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const load = (signal) => invoke('personas', { request: { action: 'read' } }, signal);
      useEffect(() => {
        const cancel = new AbortController();
        load(cancel.signal).then((result) => {
          if (!cancel.signal.aborted && result.status === 'ok') setData(result);
        }).catch(() => { if (!cancel.signal.aborted) setMessage('人格设置读取失败，请刷新。'); });
        return () => cancel.abort();
      }, [invoke, revision]);
      const change = async (request, done) => {
        setBusy(true);
        setMessage('');
        try {
          const result = await invoke('personas', { request });
          if (result.status !== 'ok') {
            setMessage(result.status === 'limit' ? '最多可添加 50 个人格。' : '设置未保存，请检查输入。');
            return;
          }
          setData(await load());
          done?.();
          setMessage(request.action === 'reset' ? '已重开。下次收到消息时会用当前人格开始新对话。'
            : request.action === 'select' ? '人格已切换，下次消息会开启新对话。' : '已保存。');
        } catch { setMessage('保存失败，请重试。'); }
        finally { setBusy(false); }
      };
      const blank = { personaId: '', name: '', prompt: '' };
      const editedPersona = data?.personas.find(({ id }) => id === (storedDraft?.personaId ?? editedId));
      const draft = storedDraft ?? (editedPersona ? { personaId: editedPersona.id, name: editedPersona.name, prompt: editedPersona.prompt } : blank);
      const dirty = draft.name.trim() !== (editedPersona?.name ?? '') || draft.prompt.trim() !== (editedPersona?.prompt ?? '');
      const edit = (fields) => {
        const next = { ...draft, ...fields };
        setEditedId(next.personaId);
        setDraft(next.name.trim() !== (editedPersona?.name ?? '') || next.prompt.trim() !== (editedPersona?.prompt ?? '')
          ? next : undefined);
      };
      const target = data?.targets.find(({ id }) => id === targetId) ?? data?.targets[0];
      const currentPersona = data?.personas.find(({ id }) => id === (target?.personaId ?? data.defaultGroup));
      const options = (data?.personas ?? []).map(({ id, name }) => h('option', { key: id, value: id }, name));
      return h('section', { style: { ...sectionStyle, display: 'grid', gap: 12, fontSize: type.body } },
        h('h3', { style: { margin: 0 } }, section === 'library' ? '角色库' : '会话使用的人设'),
        h('p', { style: { margin: 0 } }, '猫猫是内置人格。你可以添加角色设定，并为每个 QQ 群或已绑定的私聊单独选择。'),
        section === 'assignments' && data && h('label', { style: lineStyle }, '新 QQ 群默认人格',
          h('select', { style: inputStyle, value: data.defaultGroup, disabled: busy,
            onChange: (event) => change({ action: 'default', personaId: event.target.value }) }, options)),
        section === 'assignments' && data && h('p', { style: mutedStyle }, '切换后立即生效。新群默认只用于之后接入的群。'),
        section === 'assignments' && (target ? h('div', { style: { display: 'grid', gap: 8 } },
          h('label', { style: lineStyle }, '选择会话',
            h('select', { style: inputStyle, value: target.id, disabled: busy,
              onChange: (event) => setTargetId(event.target.value) },
            data.targets.map(({ id, label }) => h('option', { key: id, value: id }, label)))),
          h('div', { style: lineStyle },
            h('label', { style: lineStyle }, '当前人格',
              h('select', { style: inputStyle, value: target.personaId, disabled: busy,
                onChange: (event) => change({ action: 'select', targetId: target.id, personaId: event.target.value }) }, options)),
            button('重开此会话', () => change({ action: 'reset', targetId: target.id }), busy)),
          h('p', { style: { margin: 0 } }, '切换人格或重开会从新的对话上下文开始，已保存的长期记忆会保留。'))
          : data && h('p', { style: { margin: 0 } }, '还没有绑定的群或私聊。可在「渠道与会话」中接入。')),
        section === 'assignments' && currentPersona && h('label', { style: { display: 'grid', gap: 5 } }, `当前角色设定 · ${currentPersona.name}`,
          h('textarea', { style: inputStyle, rows: 6, readOnly: true, value: currentPersona.prompt })),
        section === 'library' && data && h('form', { style: { display: 'grid', gap: 8 }, onSubmit: (event) => {
          event.preventDefault();
          void change({ action: 'save', ...draft }, () => { setEditedId(''); clearDraft(); });
        } },
          h('label', { style: lineStyle }, '编辑角色',
            h('select', { style: inputStyle, value: draft.personaId, disabled: busy || dirty,
              onChange: (event) => setEditedId(event.target.value) }, h('option', { value: '' }, '添加新角色'),
            data.personas.map(({ id, name }) => h('option', { key: id, value: id }, name)))),
          h('label', { style: lineStyle }, '角色名称', h('input', { style: inputStyle, value: draft.name,
            disabled: busy || draft.personaId === 'maomao', required: true, maxLength: 40, onChange: (event) => edit({ name: event.target.value }) })),
          h('label', { style: { display: 'grid', gap: 5 } }, '角色设定', h('textarea', { style: inputStyle, value: draft.prompt,
            rows: 9, required: true, readOnly: draft.personaId === 'maomao', disabled: busy, maxLength: 5000, placeholder: '描述角色的身份、说话风格和性格',
            onChange: (event) => edit({ prompt: event.target.value }) })),
          draft.personaId === 'maomao' ? h('p', { style: mutedStyle }, '猫猫是内置人设，只读。选择「添加新角色」即可创建自己的角色。')
            : saveControl('保存角色', undefined, busy || !dirty, dirty, 'submit'),
          dirty && h('div', null, button('撤销本次编辑', () => { setEditedId(draft.personaId); clearDraft(); }, busy))),
        h('p', { role: 'status', style: { margin: 0 } }, message || (data ? '' : '正在读取人格设置…')));
    }

    function StatusCard({ title, rows }) {
      return h('section', { style: sectionStyle },
        h('h3', { style: { margin: '0 0 10px' } }, title),
        h('dl', { style: { margin: 0, display: 'grid', gap: 8 } }, rows.map(([name, value]) =>
          h('div', { key: name, style: { display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: type.body } },
            h('dt', { style: { flexShrink: 0 } }, name),
            h('dd', { style: { margin: 0, textAlign: 'end', overflowWrap: 'anywhere' } }, value)))));
    }

    function Panel({ invoke, drafts, navigation }) {
      const [revision, refresh] = useState(0);
      const [preferred, setPreferred] = useState(null);
      const [relink, setRelink] = useState(null);
      const [state, setState] = useState({ pending: true });
      const location = useSyncExternalStore(navigation.subscribe, navigation.read).location ?? {};
      const view = Object.hasOwn(panelPages, location.view) ? location.view : 'home';
      const platform = platforms.includes(location.platform) ? location.platform : 'feishu';
      const channelTab = location.channelTab ?? 'connection';
      const modelTab = location.modelTab ?? 'chat';
      const memoryTab = location.memoryTab ?? 'learning';
      const personaTab = location.personaTab ?? 'assignments';
      const activityTab = location.activityTab ?? 'groups';
      const diagnosticPlatform = location.diagnosticPlatform ?? 'qq';
      const go = (patch) => navigation.write('location', { ...(navigation.read().location ?? {}), ...patch });
      const draftKeys = Object.keys(useSyncExternalStore(drafts.subscribe, drafts.read));
      const hasDrafts = draftKeys.length > 0;
      const dirtyPage = (page) => draftKeys.some(key => draftDestination(key).view === page);
      useEffect(() => {
        if (!hasDrafts) return;
        const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
      }, [hasDrafts]);
      const onChange = useCallback(() => refresh(value => value + 1), []);
      useEffect(() => {
        const cancel = new AbortController();
        setState(previous => ({ ...previous, pending: true, error: null }));
        invoke('status', {}, cancel.signal).then(snapshot => {
          if (!cancel.signal.aborted) setState({ snapshot, pending: false });
        }).catch(() => {
          if (!cancel.signal.aborted) setState(previous => ({ ...previous, pending: false, error: '状态读取失败，请刷新重试。' }));
        });
        return () => cancel.abort();
      }, [revision, invoke]);
      const snapshot = state.snapshot;
      const canRelink = route => route.platform !== 'qq' && snapshot.channels[route.platform] === 'ready'
        && snapshot.bindings.private.some(owner => owner.id !== route.ownerId
          && owner.channels.includes(route.platform === 'feishu' ? 'telegram' : 'feishu'));
      const openRelink = route => { setRelink(route); go({ platform: route.platform, view: 'channels', channelTab: 'bindings' }); };
      const openChannel = value => {
        setRelink(null);
        go({ platform: value, view: 'channels', channelTab: snapshot?.channels[value] === 'ready' ? 'bindings' : 'connection' });
      };
      const openModels = () => go({ view: 'models', modelTab: 'chat' });
      const onBound = route => { if (route) setPreferred(route); onChange(); };
      const relinkTargets = snapshot?.bindings.managed.filter(canRelink) ?? [];
      const awaitingConnection = snapshot && Object.values(snapshot.channels).includes('waiting');
      useEffect(() => {
        if (!awaitingConnection) return;
        const poll = setInterval(onChange, 3000);
        const end = setTimeout(() => clearInterval(poll), 90_000);
        return () => { clearInterval(poll); clearTimeout(end); };
      }, [awaitingConnection, onChange]);
      const channelRoutes = snapshot?.bindings.managed.filter(route => route.platform === platform) ?? [];
      const last = snapshot?.sharing.last;
      const pageHeader = h('div', null, h('h2', { style: { margin: '0 0 5px' } }, panelPages[view][0]),
        h('p', { style: mutedStyle }, panelPages[view][1]));
      return h('div', { className: 'maomao-panel', style: { display: 'grid', gap: 18, padding: '4px 0 20px', color: 'var(--dsw-alias-label-primary)' } },
        h('style', null, panelCss),
        h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } },
          h('div', { style: lineStyle }, h(CatIcon, { size: 26 }),
            h('strong', { className: 'maomao-lead' }, '猫猫'), h('span', { style: { opacity: 0.72, fontSize: type.caption } }, '控制面板')),
          button(state.pending ? '刷新中…' : '刷新状态', onChange, state.pending)),
        state.error && h('p', { role: 'alert', style: { margin: 0 } }, state.error),
        !snapshot && h('p', { role: 'status', style: { margin: 0 } }, '正在读取状态…'),
        snapshot && h('div', { className: 'maomao-layout' },
          h('nav', { className: 'maomao-nav', 'aria-label': '猫猫面板设置' },
            [['开始', ['home', 'channels']], ['管理', ['personas', 'models', 'memory']], ['运行', ['activity', 'diagnostics']]].map(([title, pages]) =>
              h('div', { key: title, className: 'maomao-nav-group' }, h('div', { className: 'maomao-nav-label' }, title),
                pages.map(name => h('button', { key: name, type: 'button', className: view === name ? 'selected' : '',
                  'aria-pressed': view === name, onClick: () => go({ view: name }) }, panelPages[name][0],
                  dirtyPage(name) && h('span', { className: 'maomao-draft-dot' }, ' · 未保存')))))),
          h('main', { className: 'maomao-main', 'aria-label': panelPages[view][0], 'aria-busy': state.pending },
            pageHeader,
            hasDrafts && h('div', { role: 'status', style: { ...sectionStyle, borderColor: '#b8791f', background: 'rgba(224,154,30,.08)', display: 'grid', gap: 6 } },
              h('span', null, '有未保存的修改，切页不会丢失。退出 DSH 前请保存。'),
              h('div', { style: lineStyle }, [...new Set(draftKeys.map(key => draftDestination(key).view))].map(page =>
                h('button', { key: page, type: 'button', style: inputStyle,
                  onClick: () => go(draftDestination(draftKeys.find(key => draftDestination(key).view === page))) }, `继续编辑${panelPages[page][0]}`)))),
            view === 'home' && h(QuickStart, { snapshot, openChannel, go }),
            h('div', { hidden: view !== 'channels', style: stackStyle },
              h(ChannelCards, { snapshot, selected: platform, onSelect: openChannel }),
              h(Subnav, { label: '渠道配置步骤', value: channelTab,
                options: [['connection', '1 连接 Bot'], ['bindings', '2 会话与权限'], ['test', '3 测试回复']],
                onChange: channelTab => go({ channelTab }), dirty: id => id === 'bindings' && dirtyPage('channels') }),
              h('div', { hidden: channelTab !== 'connection' },
                h(ChannelWizard, { key: platform, snapshot, invoke, onChange, platform })),
              h('div', { hidden: channelTab !== 'bindings', style: stackStyle },
                h(BindingManagement, { key: `management-${platform}`, entries: channelRoutes, owners: snapshot.bindings.private,
                  platform, invoke, onChange, canRelink, onRelink: openRelink }),
                platform !== 'qq' && h(PrivateGroups, { key: `groups-${platform}`, invoke, platform }),
                relink ? h(BindingControls, { key: relink.id, snapshot, invoke, platform, relink,
                  closeRelink: () => setRelink(null), onBound: () => { setRelink(null); onChange(); } })
                  : h(Disclosure, { key: `add-${platform}-${channelRoutes.length}`, title: '添加绑定', initial: !channelRoutes.length },
                    h(BindingControls, { key: `binding-${platform}`, snapshot, invoke, onBound, platform })),
                platform === 'qq' && h(QqDirectMessages, { settings: snapshot.qqDirectMessages ?? {},
                  online: snapshot.channels.qq === 'ready', invoke, onChange, drafts }),
                h('details', null, h('summary', { style: { cursor: 'pointer' } }, '连接、配对和主人有什么区别？'),
                  h('p', { style: mutedStyle }, '连接让 Bot 上线；配对允许这个群或私聊聊天；主人绑定决定身份与普通私聊记忆归属。QQ 群的聊天授权不等于主人身份；QQ 私聊可在配对时关联到已有主人，和其他渠道共享私聊记忆。'))),
              h('div', { hidden: channelTab !== 'test' },
                h(FirstReply, { key: `first-reply-${platform}`, snapshot, invoke, platform, preferred, openModels }))),
            view === 'personas' && h(ReactFragment, null,
              h(Subnav, { label: '人设管理', value: personaTab, options: [['assignments', '会话分配'], ['library', '角色库']],
                onChange: personaTab => go({ personaTab }), dirty: id => id === 'library' && dirtyPage('personas') }),
              h(PersonaSettings, { invoke, revision, drafts, section: personaTab })),
            view === 'models' && h(ReactFragment, null,
              h(Subnav, { label: '模型用途', value: modelTab, options: [['chat', '对话'], ['vision', '识图'], ['image', '生图'], ['voice', '语音'], ['embedding', '向量检索'], ['web', '联网与浏览器'], ['credentials', '服务凭据']],
                onChange: modelTab => go({ modelTab }), dirty: id => draftKeys.some(key => key === `models:${id}` || key.startsWith(`models:${id}:`)) }),
              modelTab === 'chat' ? h(ChatModels, { invoke, drafts }) : modelTab === 'web' ? h(WebSettings, { invoke, drafts }) : h(MediaModels, { invoke, onChange, drafts, selected: modelTab })),
            view === 'memory' && h(ReactFragment, null,
              h(Subnav, { label: '记忆管理', value: memoryTab, options: [['learning', '自主学习'], ['stickers', '表情库'], ['settings', '范围与共享'], ['index', '向量索引']],
                onChange: memoryTab => go({ memoryTab }), dirty: id => draftKeys.some(key => key.startsWith('memory:') && draftDestination(key).memoryTab === id) }),
              memoryTab === 'learning' && h(LearningView, { invoke, drafts }),
              memoryTab === 'stickers' && h(StickerLibrary, { invoke }),
              memoryTab === 'settings' && h(ReactFragment, null,
                h(StatusCard, { title: '当前记忆范围', rows: [['私聊记忆', enabled(snapshot.memory.private)],
                  ['同一主人跨渠道共享', sharedMemoryStates[snapshot.memory.sharedState] ?? enabled(snapshot.memory.shared)],
                  ['QQ 群与未关联私聊', enabled(snapshot.memory.qq)]] }),
                snapshot.memory.sharedState === 'waiting_owner' && relinkTargets.length > 0 && button('关联同一主人', () => openRelink(relinkTargets[0])),
                h(MemorySettings, { invoke, onChange, drafts, section: 'memory' })),
              memoryTab === 'index' && h(ReactFragment, null, h(EmbeddingIndex, { invoke }),
                h('div', null, button('配置向量模型', () => go({ view: 'models', modelTab: 'embedding' }))))),
            view === 'activity' && h(ReactFragment, null,
              h(Subnav, { label: '主动互动类型', value: activityTab, options: [['groups', 'QQ 群接话'], ['sharing', '私聊主动分享']],
                onChange: activityTab => go({ activityTab }), dirty: id => draftKeys.some(key => {
                  const destination = draftDestination(key); return destination.view === 'activity' && destination.activityTab === id;
                }) }),
              activityTab === 'groups' ? h(ReactFragment, null,
                snapshot.qqPeerGroups?.length ? h(QqPeerSettings, { groups: snapshot.qqPeerGroups, invoke, onChange, drafts })
                  : h('section', { style: { ...sectionStyle, ...stackStyle } }, h('p', { style: mutedStyle }, '先绑定一个 QQ 群，再设置它的接话轮数与暂停状态。'),
                    h('div', null, button('去绑定 QQ 群', () => openChannel('qq')))))
                : h(ReactFragment, null,
                  h(StatusCard, { title: '分享状态', rows: [['运行模式', modes[snapshot.sharing.mode]], ['目标渠道', destinations[snapshot.sharing.destination] ?? '未设置'],
                    ['最近一次检查', last ? [results[last.status], timestamp(last.at)].join(' · ') : '尚无记录']] }),
                  h(MemorySettings, { invoke, onChange, drafts, section: 'sharing' }),
                  h(SharePreview, { invoke }))),
            view === 'diagnostics' && h(ReactFragment, null,
              h(Subnav, { label: '诊断渠道', value: diagnosticPlatform, options: [...platforms.map(key => [key, destinations[key]]), ['api', 'API 报错'], ['terminal', '终端']],
                onChange: diagnosticPlatform => go({ diagnosticPlatform }) }),
              diagnosticPlatform === 'terminal' && h(LogTerminal, { invoke }),
              diagnosticPlatform === 'api' && h(ApiErrors, { invoke }),
              platforms.includes(diagnosticPlatform) && h(StatusCard, { title: `${destinations[diagnosticPlatform]} 最近处理`, rows: [
                ['渠道状态', states[snapshot.channels[diagnosticPlatform]]],
                ...Object.entries({ receive: '收件', model: '对话模型', reply: '投递' }).map(([kind, name]) => {
                  const event = snapshot.diagnostics?.[diagnosticPlatform]?.[kind];
                  return [name, event ? `${{ ok: '成功', empty: '未返回文本', failed: '失败' }[event.outcome]} · ${timestamp(event.at)}` : '暂无记录'];
                }),
                ...(diagnosticPlatform === 'qq' ? [['格式消息', snapshot.formats?.qq
                  ? `QQ 拒绝了${snapshot.formats.qq.keyboard ? '按钮卡片' : 'Markdown'}${snapshot.formats.qq.code ? `（代码 ${snapshot.formats.qq.code}）` : ''}，已改发纯文字 · ${timestamp(snapshot.formats.qq.at)}`
                  : '暂无被拒记录']] : []),
                ['媒体下载', snapshot.media[diagnosticPlatform] ? `${mediaLabels[snapshot.media[diagnosticPlatform].outcome]} · ${timestamp(snapshot.media[diagnosticPlatform].at)}` : '暂无记录'],
              ] }),
              platforms.includes(diagnosticPlatform) && h('div', { style: lineStyle }, button('检查渠道连接', () => { setRelink(null); go({ view: 'channels', platform: diagnosticPlatform, channelTab: 'connection' }); }),
                button('验证聊天回复', () => { setRelink(null); go({ view: 'channels', platform: diagnosticPlatform, channelTab: 'test' }); }),
                button('检查对话模型', openModels))))));
    }

    // 诊断 → 终端 / API 报错. The terminal polls the rolling log of this run; API errors are kept for 90 days.
    const logLevels = [['error', '错误'], ['warn', '警告'], ['info', '信息'], ['debug', '调试'], ['trace', '追踪']];
    const logLevelName = Object.fromEntries(logLevels);
    const clockTime = (at) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(at % 1000).padStart(3, '0');
    function LogTerminal({ invoke }) {
      const [filters, setFilters] = useState({ level: 'debug', source: '', query: '' });
      const [query, setQuery] = useState('');
      const [rows, setRows] = useState([]);
      const [meta, setMeta] = useState(null);
      const [paused, setPaused] = useState(false);
      const [follow, setFollow] = useState(true);
      const [notice, setNotice] = useState('');
      const box = useRef(null);
      const after = useRef(0);
      useEffect(() => { after.current = 0; setRows([]); }, [filters]);
      useEffect(() => {
        if (paused) return;
        let stopped = false;
        const tick = async () => {
          try {
            const value = await invoke('diagnosticLogs', { request: { action: 'read', after: after.current, ...filters } });
            if (stopped || value?.status !== 'ok') return;
            setMeta({ level: value.level, startedAt: value.startedAt, sources: value.sources });
            if (value.rows.length) {
              after.current = value.rows.at(-1).id;
              setRows((previous) => [...previous, ...value.rows].slice(-1000));
            }
          } catch { if (!stopped) setNotice('读取日志失败，稍后自动重试。'); }
        };
        void tick();
        const timer = setInterval(tick, 2000);
        return () => { stopped = true; clearInterval(timer); };
      }, [invoke, filters, paused]);
      useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [rows, follow]);
      async function setLevel(level) {
        const value = await invoke('diagnosticLogs', { request: { action: 'level', level } }).catch(() => null);
        setNotice(value?.status === 'saved' ? `已改为记录到「${logLevelName[level]}」级别。` : '修改失败。');
        if (value?.level) setMeta((previous) => ({ ...previous, level: value.level }));
      }
      return h('section', { style: { ...sectionStyle, ...stackStyle } },
        h('h3', { style: { margin: 0 } }, '终端'),
        h('p', { style: mutedStyle }, '实时查看猫猫这次运行的调试日志：每轮对话、工具调用（记忆、技能、表情、联网、生图、语音）、接话判断、后台总结和平台报错。'
          + '只保存本次启动后的最近 24 小时，重启 DSH 后清空；密钥会被遮盖。'),
        h('div', { style: lineStyle },
          h('label', { style: lineStyle }, '显示',
            h('select', { style: inputStyle, value: filters.level, onChange: (event) => setFilters({ ...filters, level: event.target.value }) },
              logLevels.map(([id, name]) => h('option', { key: id, value: id }, `${name}及以上`)))),
          h('label', { style: lineStyle }, '来源',
            h('select', { style: inputStyle, value: filters.source, onChange: (event) => setFilters({ ...filters, source: event.target.value }) },
              h('option', { value: '' }, '全部'), (meta?.sources ?? []).map((source) => h('option', { key: source, value: source }, source)))),
          h('form', { style: lineStyle, onSubmit: (event) => { event.preventDefault(); setFilters({ ...filters, query: query.trim() }); } },
            h('input', { type: 'search', style: inputStyle, value: query, maxLength: 100, placeholder: '关键字', 'aria-label': '日志关键字',
              onChange: (event) => setQuery(event.target.value) }),
            h('button', { type: 'submit', style: inputStyle }, '筛选')),
          button(paused ? '继续' : '暂停', () => setPaused(!paused)),
          button('清屏', () => setRows([])),
          h('label', { style: lineStyle }, h('input', { type: 'checkbox', checked: follow, onChange: (event) => setFollow(event.target.checked) }), '自动滚到底部')),
        h('div', { ref: box, className: 'maomao-terminal', role: 'log', 'aria-live': 'off', 'aria-label': '调试日志' },
          rows.length ? rows.map((row) => h('div', { key: row.id, className: `maomao-log maomao-log-${row.level}` },
            h('span', { className: 'maomao-log-time' }, clockTime(row.at)), ' ',
            h('span', { className: 'maomao-log-level' }, logLevelName[row.level] ?? row.level), ' ',
            h('span', { className: 'maomao-log-source' }, `[${row.source}]`), ' ', row.event,
            row.detail && row.detail !== '""' && (row.detail.length > 160
              ? h('details', null, h('summary', null, row.detail.slice(0, 160) + '…'), h('pre', null, row.detail))
              : h('span', { className: 'maomao-log-detail' }, ' ', row.detail))))
            : h('div', { className: 'maomao-log' }, paused ? '已暂停。' : '等待日志…')),
        h('div', { style: lineStyle },
          h('label', { style: lineStyle }, '记录级别',
            h('select', { style: inputStyle, value: meta?.level ?? 'debug', onChange: (event) => setLevel(event.target.value) },
              logLevels.map(([id, name]) => h('option', { key: id, value: id }, name)))),
          h('span', { style: { ...mutedStyle, fontSize: type.caption } }, '调试会记录工具参数和结果；追踪最详细。API 报错不受这里影响，始终保存。')),
        meta?.startedAt && h('p', { style: { ...mutedStyle, fontSize: type.caption } }, `本次启动于 ${timestamp(meta.startedAt)}`),
        notice && h('p', { role: 'status', style: { margin: 0 } }, notice));
    }

    function ApiErrors({ invoke }) {
      const [rows, setRows] = useState(null);
      const [confirm, setConfirm] = useState(false);
      const [refresh, setRefresh] = useState(0);
      useEffect(() => {
        const cancel = new AbortController();
        invoke('diagnosticLogs', { request: { action: 'api' } }, cancel.signal).then((value) => {
          if (!cancel.signal.aborted) setRows(value?.rows ?? []);
        }).catch(() => { if (!cancel.signal.aborted) setRows([]); });
        return () => cancel.abort();
      }, [invoke, refresh]);
      async function clear() {
        await invoke('diagnosticLogs', { request: { action: 'clear_api' } }).catch(() => null);
        setConfirm(false); setRefresh((n) => n + 1);
      }
      return h('section', { style: { ...sectionStyle, ...stackStyle } },
        h('h3', { style: { margin: 0 } }, 'API 报错'),
        h('p', { style: mutedStyle }, '平台和模型接口返回的错误会长期保存（最多 90 天、2000 条），方便事后查原因，例如 QQ 拒绝 Markdown、图片下载失败、Telegram / 飞书接口报错、模型调用失败。'),
        h('div', { style: lineStyle }, button('刷新', () => setRefresh((n) => n + 1)),
          confirm ? h(ReactFragment, null, button('确认清空', clear, false, 'confirmDestructive'), button('取消', () => setConfirm(false)))
            : button('清空记录', () => setConfirm(true), !rows?.length, 'destructive')),
        !rows ? h('p', { role: 'status', style: mutedStyle }, '正在读取…')
          : !rows.length ? h('p', { style: { margin: 0 } }, '没有记录到 API 报错。')
            : h('div', { className: 'maomao-terminal', style: { maxHeight: '50vh' } }, rows.map((row) => h('div', { key: row.id, className: 'maomao-log maomao-log-error' },
              h('span', { className: 'maomao-log-time' }, timestamp(row.at)), ' ', h('span', { className: 'maomao-log-source' }, `[${row.source}]`), ' ',
              h('strong', null, row.code), ' ', row.message,
              row.detail && h('details', null, h('summary', null, '详情'), h('pre', null, row.detail))))));
    }

    function CatIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M4 13 4.5 4 9 8h6l4.5-4 .5 9a8 7 0 0 1-16 0Z M10.7 14.2l1.3 1 1.3-1' }),
      h('path', { d: 'M8.5 12h.01m6.99 0h.01M2 14.5l4 1m12 0 4-1M2 18l4-.5m12 0 4 .5' }));
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const drafts = createDrafts();
        const navigation = createDrafts();
        const invoke = async (method, args = {}, signal) => {
          const result = await ctx.connection.rpc.call('/api', `maomaoPanel/${method}`, { args }, signal);
          if (!result.ok) throw new Error('Maomao status unavailable');
          return result.value;
        };
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'maomao', order: 60, label: () => '猫猫',
          inject: () => ({ invoke, drafts, navigation }),
        }, Panel));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'maomao', label: () => '猫猫',
        }, CatIcon));
      },
    };
  },
});
