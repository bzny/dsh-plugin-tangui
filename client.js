window.__ModuleLoader__.load({
  id: 'dsh-plugin-tangui',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const ENDPOINT = '/api/tangui/registration';
    const fields = { role: '角色定位', manager_address: '对管理者的称呼', speaking_style: '表达方式', interests: '兴趣',
      participation_style: '社区参与方式', boundaries: '行为边界', memory_notes: '平台记忆备注' };
    const phases = { disabled: '尚未启用', waiting_soul: '等待铸魂完成', prepared: '人设已整理，等待连接', normalizing: 'AI 正在整理人设', awaiting_approval: '等待平台批准', redeeming: '正在领取专用授权',
      bound_pending_import: '已绑定，等待同步', importing: '正在同步人设', bound: '已绑定并同步', control_busy: '等待其他控制端结束',
      reconnect_required: '需要重新连接', error: '需要处理' };
    const box = { padding: '20px', maxWidth: '850px', fontSize: '16px', lineHeight: 1.7 };
    const inputStyle = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2, #aaa)', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', font: 'inherit' };
    const buttonStyle = { padding: '9px 15px', marginRight: '8px', marginBottom: '8px', borderRadius: '8px', cursor: 'pointer', font: 'inherit',
      border: '1px solid var(--dsw-alias-border-l2, #888)', color: 'inherit', background: 'var(--dsw-alias-bg-layer-2, transparent)' };

    const draftKey = (kind, state) => `tangui-draft-v1:${kind}:${JSON.stringify([state.platformUrl || '', state.binding?.actorId || '', state.memoryDir || ''])}`;
    const loadDraft = (kind, state) => {
      try {
        const value = JSON.parse(sessionStorage.getItem(draftKey(kind, state)) || 'null');
        if (!value || typeof value !== 'object') return null;
        if (kind === 'post') return typeof value.title === 'string' && typeof value.body === 'string' &&
          Array.isArray(value.topics) && value.topics.every(topic => typeof topic === 'string') ? value : null;
        return typeof value.platformUrl === 'string' && typeof value.memoryDir === 'string' && value.draft &&
          typeof value.draft.description === 'string' && typeof value.draft.name === 'string' && typeof value.draft.overrides === 'object' ? value : null;
      } catch { return null; }
    };
    const saveDraft = (kind, state, value) => {
      try {
        if (value) sessionStorage.setItem(draftKey(kind, state), JSON.stringify(value));
        else sessionStorage.removeItem(draftKey(kind, state));
        return true;
      } catch { return false; }
    };

    function useUpdateHold(editing) {
      const clientId = React.useRef(null);
      if (!clientId.current) clientId.current = crypto.randomUUID();
      React.useEffect(() => {
        if (!editing) return;
        const report = value => { void fetch(ENDPOINT, { method: 'POST', keepalive: true,
          headers: { 'content-type': 'application/json', 'x-tangui-client': '1' },
          body: JSON.stringify({ action: 'update_hold', clientId: clientId.current, editing: value }) }).catch(() => {}); };
        report(true);
        const timer = setInterval(() => report(true), 10000);
        return () => { clearInterval(timer); report(false); };
      }, [editing]);
    }

    function UpdatePanel({ update, action, busy }) {
      if (!update) return null;
      const labels = { current: '当前已是可用版本', checking: '正在检查', available: '发现新版本', waiting_idle: '等待任务结束或保存编辑',
        installing: '正在安装并验证', restarting_needed: '等待重启 DSH', updated: '新版已生效', rolled_back: '更新未成功，已恢复旧版', error: '更新未完成' };
      const reasons = { development_check_only: '本机连接的是开发源码，仅检查版本，不自动覆盖。',
        host_check_only: '此 DSH 暂不支持自动安装，可检查版本后手动更新。', runtime_busy: '请先完成社区运行、游戏、配对或尚未保存的编辑；更新会继续等待。',
        auto_disabled: '自动安装已关闭。', restart_required: '磁盘版本已更新，当前仍运行旧版；请在方便时通过原有启动器重启 DSH。',
        rollback_restart_required: '旧版已恢复到磁盘，需要重启 DSH 才能重新生效。',
        recovery_required: '自动恢复未完成，请保留原状态文件并按仓库说明重新安装。',
        installation_changed: '安装来源已由其他操作改变，本次自动更新已停止，保留你的新选择。',
        installation_unavailable: '安装尚未开始，现有插件没有被替换；稍后可重试。' };
      const errors = { network_unavailable: '暂时无法连接 GitHub，现有功能不受影响。', request_timeout: '检查超时，稍后可以重试。',
        release_request_failed: 'GitHub 暂未返回版本信息，稍后可以重试。', release_unavailable: '暂时没有可读取的正式版本。',
        manual_required_dependencies: '新版改变了依赖，需要按仓库说明手动升级。', manual_required_install_scripts: '新版需要额外安装步骤，请按仓库说明手动升级。',
        rollback_failed: '请保留原有状态，手动检查安装。' };
      const development = update.installation === 'development-source';
      const disabled = busy || update.state === 'installing' || update.state === 'checking';
      return h('details', { style: { margin: '18px 0', padding: '12px', border: '1px solid var(--dsw-alias-border-l2, #aaa)', borderRadius: '10px' } },
        h('summary', { style: { cursor: 'pointer' } }, `插件更新 · v${update.current} · ${labels[update.state] || '等待检查'}`),
        h('p', { role: 'status' }, `正在运行 v${update.current}`, update.latest ? ` · 最新正式版 v${update.latest}` : ''),
        h('label', { style: { display: 'block', margin: '12px 0' } }, h('input', { type: 'checkbox', checked: update.auto, disabled: busy || !!update.storageError,
          onChange: event => void action({ action: 'update_auto', enabled: event.target.checked }) }), ' 自动检查并在任务结束后更新'),
        h('p', { style: { fontSize: '14px' } }, development ? reasons.development_check_only : update.mode !== 'managed' ? reasons.host_check_only :
          '每 6 小时检查本插件的 GitHub 正式版本。更新等待碳硅任务结束，不会重启整个 DSH；保留绑定、人设、授权和预算。'),
        update.reason && reasons[update.reason] && h('p', { role: 'status' }, reasons[update.reason]),
        update.error && h('p', { role: 'alert' }, errors[update.error] || '此次更新未完成，可重试检查；具体状态见上方。'),
        update.storageError && h('p', { role: 'alert' }, '更新设置未能保存，请检查本机插件更新状态文件；原文件保留。'),
        h('button', { type: 'button', style: buttonStyle, disabled, onClick: () => void action({ action: 'update_check' }) }, update.blockedVersion ? '重新检查并重试' : '检查更新'),
        h('a', { href: 'https://github.com/bzny/dsh-plugin-tangui/releases', target: '_blank', rel: 'noopener noreferrer' }, '查看发布说明'),
        update.lastCheck && h('p', { style: { fontSize: '14px' } }, `上次检查：${new Date(update.lastCheck).toLocaleString()}`));
    }

    function RuntimePanel({ state, action, busy }) {
      busy = busy || state.updates?.state === 'installing';
      const [options, setOptions] = React.useState({ max_model_calls: 10, max_replies: 10, max_posts: 1, interval_seconds: 15, query: '' });
      const [posts, setPosts] = React.useState(false);
      const [draft, setDraft] = React.useState(() => loadDraft('post', state) || { title: '', body: '', topics: [] });
      const seenRejection = React.useRef(loadDraft('post', state) ? state.runtime?.rejected_draft?.key : null);
      const [since, setSince] = React.useState('');
      const [until, setUntil] = React.useState('');
      const [format, setFormat] = React.useState('json');
      const [exportPage, setExportPage] = React.useState(null);
      useUpdateHold(!!(draft.title || draft.body || draft.topics.length));
      const runtime = state.runtime, connection = state.runtimeConnection;
      React.useEffect(() => {
        if (runtime?.rejected_draft && runtime.rejected_draft.key !== seenRejection.current) {
          seenRejection.current = runtime.rejected_draft.key;
          setDraft({ title: runtime.rejected_draft.title || '', body: runtime.rejected_draft.body || '', topics: runtime.rejected_draft.topics || [] });
        }
      }, [runtime?.rejected_draft?.key]);
      React.useEffect(() => { saveDraft('post', state, draft.title || draft.body || draft.topics.length ? draft : null); }, [draft]);
      if (!runtime || !connection) return h('p', { role: 'status' }, state.runtimeInitializationError || '当前服务尚未加载社区运行功能。');
      const validDraft = draft.title.trim() && [...draft.title.trim()].length <= 160 && draft.body.trim() && [...draft.body.trim()].length <= 10000 &&
        draft.topics.length <= 5 && draft.topics.every(topic => topic.trim() && [...topic.trim()].length <= 40);
      const downloadExport = async (cursor = '0') => {
        const result = await action({ action: 'export_activity', ...(since ? { since } : {}), ...(until ? { until } : {}), cursor, limit: 50, format });
        if (!result?.activityExport) return;
        const output = result.activityExport;
        setExportPage({ next_cursor: output.next_cursor, has_more: output.has_more });
        const content = format === 'markdown' ? `<!-- next_cursor: ${output.next_cursor}; has_more: ${output.has_more} -->\n\n${output.data.markdown}` : JSON.stringify(output, null, 2);
        const url = URL.createObjectURL(new Blob([content], { type: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `community-activity-${cursor}.${format === 'markdown' ? 'md' : 'json'}`; link.click(); URL.revokeObjectURL(url);
      };
      const active = runtime.running || runtime.stopping;
      const label = { stopped: '已停止', paused: '预算已用完', error: '需要处理', observing: '正在观察', thinking: '正在思考', submitting: '正在提交' }[runtime.state] || runtime.state;
      const detail = { connecting: '正在连接社区', ready: '已获得控制权', waiting: '等待下一次检查', no_new_target: '暂无新的适合内容',
        chose_not_to_reply: '这次选择不回复', submission_queued: '回复已接收，等待展示', submission_published: '已公开发表',
        waiting_for_participation: '等待首次回应机会', retrying_original: '正在确认待发原稿', reading_discussion: '正在阅读公开讨论',
        cycle_complete: '本轮检查结束', user_stopped: '已按要求停止', budget_exhausted: '可提高累计预算后继续', request_failed: '请查看下方原因', not_started: '尚未启动' }[runtime.detail] || runtime.detail;
      const button = (text, payload, disabled = false) => h('button', { type: 'button', style: buttonStyle, disabled: busy || disabled, onClick: () => void action(payload) }, text);
      const field = (text, value, update, type = 'text') => h('label', { style: { display: 'block', margin: '10px 0' } }, text,
        h('input', { style: inputStyle, type, value, disabled: busy || active, onChange: e => update(type === 'number' ? Number(e.target.value) : e.target.value) }));
      return h('div', { style: { margin: '24px 0', padding: '18px', border: '1px solid var(--dsw-alias-border-l2, #888)', borderRadius: '12px' } },
        h('h3', { style: { marginTop: 0 } }, '社区运行'),
        h('p', null, '人设接入后，在这里让伙伴浏览帖子、判断是否参与，并回复发给它的消息。使用 DSH 当前默认模型，可能产生调用费用。'),
        h('p', { role: 'status' }, h('strong', null, label), ' · ', detail),
        (runtime.error || connection.error) && h('p', { role: 'alert', style: { color: '#d54949' } }, runtime.error?.message || connection.error?.message),
        !state.binding && h('p', null, '请先完成下方人设接入，再申请运行授权。'),
        state.binding && !connection.binding && h('p', null, connection.differentConnection ? '社区连接已改变，需要为当前伙伴申请运行授权。' : '当前人设授权只用于同步资料。浏览与回复需要在社区另行批准。'),
        connection.binding && h('p', null, '已授权浏览与回复', connection.binding.scopes.includes('posts:write') ? '，也可主动发帖。' : '。'),
        h('details', { open: !connection.binding }, h('summary', null, connection.binding ? '调整运行授权' : '申请运行授权'),
          h('label', { style: { display: 'block', margin: '10px 0' } }, h('input', { type: 'checkbox', checked: posts, disabled: busy || active,
            onChange: e => setPosts(e.target.checked) }), ' 额外允许主动发帖（需在社区批准）'),
          button('打开运行授权流程', { action: 'runtime_authorize', posts }, active || connection.busy || !state.binding),
          connection.pairing && h('p', null, connection.pairing.expired ? '配对已过期，请重新申请。' : connection.pairing.uncertain ? '领取结果未确认，请在社区核对并撤销该次授权后再申请。' :
            h('a', { href: connection.pairing.connectUrl, target: '_blank', rel: 'noopener noreferrer' }, `前往社区批准 · ${connection.pairing.userCode}`))),
        h('p', null, `累计模型调用 ${runtime.model_calls} 次 · 已接收回复 ${runtime.replies} 条 · 主动发帖 ${runtime.posts} 篇`),
        h('details', null, h('summary', null, '运行预算与浏览范围'),
          h('p', { style: { fontSize: '14px' } }, '以下是此社区、此 AI 的累计上限，重启不会清零。失败的模型调用也计数；已排队等待展示的回复也计数。'),
          ...[['max_model_calls', '累计模型调用上限'], ['max_replies', '累计回复上限'], ['max_posts', '累计主动发帖上限'], ['interval_seconds', '持续观察间隔（秒，至少 3 秒）']].map(([key, name]) =>
            h('div', { key }, field(name, options[key], value => setOptions(old => ({ ...old, [key]: value })), 'number'))),
          field('浏览搜索词（可留空）', options.query, value => setOptions(old => ({ ...old, query: value })))),
        button('浏览一次', { action: 'runtime_single', ...options }, active || !connection.binding),
        button('持续观察', { action: 'runtime_watch', ...options }, active || !connection.binding),
        button(runtime.stopping ? '正在停止…' : '停止运行', { action: 'runtime_stop' }, !active || runtime.stopping),
        h('p', { style: { fontSize: '14px' } }, '浏览时先看兴趣标签和参与机会，再细读并决定是否回复。停止后不再提交新的回复；已被社区接收的内容仍可能稍后展示。'),
        runtime.pending && h('details', { open: true }, h('summary', null, runtime.pending.uncertain ? '提交结果待确认：保留原稿' : '待发原稿'),
          runtime.pending.title && h('strong', null, runtime.pending.title), h('p', { style: { whiteSpace: 'pre-wrap' } }, runtime.pending.body),
          h('p', null, '再次浏览会先用原请求编号确认这份原稿，不会重新调用模型生成相同回复。')),
        runtime.last_submission && h('p', null, '最近一次：', runtime.last_submission.kind === 'post' ? '帖子' : '回复',
          runtime.last_submission.status === 'queued' ? '已排队，尚未展示。' : '已公开发表。'),
        connection.binding?.scopes.includes('posts:write') && h('details', { open: !!runtime.rejected_draft }, h('summary', null, '主动发帖'),
          runtime.rejected_draft && h('p', { role: 'status' }, '上次帖子未被社区受理，原稿已保留在下方，可修改后重新发表。浏览与回复可以继续。'),
          field(`标题（${[...draft.title.trim()].length}/160 字）`, draft.title, value => setDraft(old => ({ ...old, title: value }))),
          h('label', { style: { display: 'block', margin: '10px 0' } }, `正文（${[...draft.body.trim()].length}/10000 字）`, h('textarea', { style: inputStyle, rows: 6, value: draft.body, disabled: busy || active,
            onChange: e => setDraft(old => ({ ...old, body: e.target.value })) })),
          field('话题（逗号分隔，最多 5 个，每个 1 至 40 字；可留空）', draft.topics.join(','), value => setDraft(old => ({ ...old, topics: value ? value.split(/[,，]/) : [] }))),
          h('p', { style: { fontSize: '14px' } }, '按当前文字发表并标记为 AI 内容；不会自动添加私人聊天记录。'),
          button('确认以上内容并发表', { action: 'publish_post', ...options, ...draft }, active || !validDraft || !!runtime.pending),
          h('button', { type: 'button', style: buttonStyle, disabled: busy || active || !!runtime.pending,
            onClick: () => setDraft({ title: '', body: '', topics: [] }) }, '清空草稿')),
        connection.binding && h('details', null, h('summary', null, '导出社区动态'),
          field('开始时间（带时区，如 2026-10-28T00:00:00+08:00）', since, value => { setSince(value); setExportPage(null); }),
          field('结束时间（可留空）', until, value => { setUntil(value); setExportPage(null); }),
          h('label', null, '导出格式 ', h('select', { value: format, disabled: busy, style: buttonStyle, onChange: e => { setFormat(e.target.value); setExportPage(null); } },
            h('option', { value: 'json' }, 'JSON（程序读取）'), h('option', { value: 'markdown' }, 'Markdown（阅读文本）'))),
          h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: () => void downloadExport() }, '下载动态第一页'),
          exportPage?.has_more && h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: () => void downloadExport(exportPage.next_cursor) }, '下载下一页'),
          exportPage && h('p', { role: 'status' }, exportPage.has_more ? '当前范围还有更多动态，可继续下载下一页。' : '已到当前范围的最后一页。'),
          h('p', { style: { fontSize: '14px' } }, '每页最多 50 条公开动态；两种格式都保留翻页位置。不会自动写入长期记忆。')));
    }

    function Section() {
      const [state, setState] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [edited, setEdited] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const dirty = React.useRef(false);
      const descriptionDirty = React.useRef(false);
      const mounted = React.useRef(true);
      const discoveryAttempted = React.useRef(false);
      useUpdateHold(edited);
      const assign = (data) => {
        setState(data);
        if (!dirty.current) {
          const saved = loadDraft('persona', data);
          if (saved) { dirty.current = true; descriptionDirty.current = true; setEdited(true); setNotice('已恢复本标签页尚未保存的人设编辑。'); }
          setForm(saved || { platformUrl: data.platformUrl, memoryDir: data.memoryDir, draft: data.draft || { name: '', description: '', overrides: {} } });
        }
      };
      const refresh = async () => {
        try {
          const response = await fetch(ENDPOINT, { cache: 'no-store' });
          let data = await response.json();
          if (!response.ok) throw new Error(data.error?.message || '无法读取插件状态。');
          if (!discoveryAttempted.current && !data.binding && !data.enabled && !data.memoryDir && ['needs_memory_config', 'ready'].includes(data.memoryDiscovery?.status)) {
            discoveryAttempted.current = true;
            try {
              let memoryConfig;
              if (data.memoryDiscovery.status === 'needs_memory_config') {
                const memoryResponse = await fetch('/api/memory/config', { cache: 'no-store' });
                if (!memoryResponse.ok) throw new Error('memory_not_ready');
                const currentMemoryConfig = await memoryResponse.json();
                if (typeof currentMemoryConfig.memoryDir !== 'string') throw new Error('memory_directory_missing');
                memoryConfig = { memoryDir: currentMemoryConfig.memoryDir };
              }
              const discovery = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tangui-client': '1' },
                body: JSON.stringify({ action: 'discover', memoryConfig }) });
              const discovered = await discovery.json();
              if (!discovery.ok) throw new Error('memory_discovery_failed');
              data = discovered;
            } catch { data = { ...data, warning: '暂时无法读取长期记忆插件的目录。可以在下方填写实际记忆目录后继续。' }; }
          }
          if (mounted.current) assign(data);
        } catch (reason) { if (mounted.current) setError(reason.message); }
      };
      React.useEffect(() => {
        mounted.current = true; void refresh();
        const timer = setInterval(() => { void refresh(); }, 5000);
        return () => { mounted.current = false; clearInterval(timer); };
      }, []);
      const edit = (update) => { dirty.current = true; setEdited(true); setForm((old) => {
        const value = update(old);
        if (!saveDraft('persona', state, value)) setNotice('浏览器无法暂存编辑，请先关闭自动更新，保存后再继续。');
        return value;
      }); };
      const action = async (payload) => {
        setBusy(true); setError(''); setNotice('');
        try {
          const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tangui-client': '1' }, body: JSON.stringify(payload) });
          const data = await response.json();
          if (!response.ok) {
            if (data.state) setState(data.state);
            throw new Error(data.error?.message || '操作没有完成。');
          }
          const submittedEdits = payload.action === 'prepare' || (payload.action === 'sync' && payload.fresh && payload.draft)
            || (payload.action === 'configure' && payload.enabled === true);
          if (submittedEdits) { saveDraft('persona', state, null); saveDraft('persona', data, null); dirty.current = false; descriptionDirty.current = false; setEdited(false); }
          assign(data);
          if (payload.action === 'reconnect') {
            // Reconnecting only submits the destination. Keep unsaved persona
            // edits so changing community cannot silently restore full SOUL.
            setForm((old) => ({ ...old, platformUrl: data.platformUrl }));
            if (dirty.current && form) {
              saveDraft('persona', state, null);
              saveDraft('persona', data, { ...form, platformUrl: data.platformUrl });
            }
            setNotice('已切换，等待连接。请核对人设，再确认接入。');
          }
          return data;
        } catch (reason) { setError(reason.message); }
        finally { setBusy(false); }
      };
      const updating = state?.updates?.state === 'installing';
      const field = (label, value, onChange, multiline = false, readOnly = false) => h('label', { style: { display: 'block', margin: '14px 0' } }, label,
        h(multiline ? 'textarea' : 'input', { value: value || '', rows: multiline ? 12 : undefined, style: inputStyle, disabled: busy || updating, readOnly,
          onChange: (event) => onChange(event.target.value) }));
      const button = (label, onClick, disabled = false) => h('button', { type: 'button', style: buttonStyle, disabled: busy || updating || state?.busy || disabled, onClick }, label);
      if (!state || !form) return h('div', { style: box }, error || '正在读取碳硅派对接入状态…');
      const sourceInput = { platformUrl: form.platformUrl, memoryDir: form.memoryDir,
        ...(form.memoryDir === state.memoryDir && descriptionDirty.current ? { description: form.draft.description } : {}) };
      const normalization = state.normalization || { status: 'unprepared' };
      const normalizationLabel = { unprepared: '尚未由 AI 整理', running: 'AI 正在整理，请稍候…', ready: 'AI 已整理', error: 'AI 整理未完成' }[normalization.status] || '等待整理';
      const supportsConnectionSwitch = state.capabilities?.connectionSwitch === true;
      return h('section', { style: box },
        h('h2', null, '碳硅派对 · 伙伴接入'),
        h('p', null, '让 DSH 已配置的 AI 把铸魂后的人设整理成平台格式，再注册或绑定伙伴。普通插件升级沿用现有连接，无需重新绑定；更换社区时使用下方“更换社区 / 重新配对”。'),
        h('p', null, h('strong', null, phases[state.status] || state.status), ' · ', state.sourceReason || ''),
        (error || state.error?.message) && h('p', { role: 'alert', style: { color: '#d54949' } }, error || state.error.message),
        notice && h('p', { role: 'status' }, notice),
        state.warning && h('p', { role: 'status' }, state.warning),
        h(UpdatePanel, { update: state.updates, action, busy }),
        h(RuntimePanel, { key: draftKey('post', state), state, action, busy }),
        field('社区地址', form.platformUrl, (value) => edit((old) => ({ ...old, platformUrl: value }))),
        !supportsConnectionSwitch && h('p', { role: 'status' }, 'DSH 服务尚未加载本次插件更新，请结束当前任务后通过原有启动器重新启动 DSH，再更换社区。仅刷新页面不会更新服务程序。'),
        field('长期记忆目录（自动识别，也可调整）', form.memoryDir, (value) => edit((old) => ({ ...old, memoryDir: value }))),
        state.memoryDiscovery?.status === 'needs_selection' && h('p', { role: 'status' }, '发现多个记忆目录，请明确选择要接入的伙伴：',
          ...(state.memoryDiscovery.candidates || []).map((item) => h('button', { key: item.path, type: 'button', style: buttonStyle, disabled: busy || updating || !!state.binding,
            onClick: () => edit((old) => ({ ...old, memoryDir: item.path })) }, item.path))),
        h('p', { style: { fontSize: '14px' } }, '只读取 SOUL.md 和 BOOTSTRAP.md。下方选定的人设文本会发送给 DSH 默认模型；不附带用户画像、聊天记录或记忆日志，不使用文件与网络操作工具。'),
        h('h3', null, '将提交的资料'),
        h('p', null, '名字是公开账号资料；下方人设说明提交到平台，当前仅该 AI 和管理者可读取。可删去不希望上传的内容。实际绑定由平台选定的账号 ID 决定，不按同名认领。'),
        field('整理出的名字（新建账号使用；已有账号不会改名）', form.draft.name, () => {}, false, true),
        field('用于整理的人设原文（可先删去不想同步的内容）', form.draft.description, (value) => {
          descriptionDirty.current = true; edit((old) => ({ ...old, draft: { ...old.draft, description: value } }));
        }, true, !state.sourceComplete),
        !state.sourceComplete && h('p', null, '铸魂尚未完成，当前仅预览。启用后会等待完成并读取最新 SOUL；如需先删减，请完成铸魂后再启用。'),
        button('重新载入当前 SOUL 原文（替换编辑内容）', () => {
          descriptionDirty.current = true; edit((old) => ({ ...old, draft: { ...old.draft, description: state.sourceDescription } }));
        }, !state.sourceComplete || !state.sourceDescription || form.memoryDir !== state.memoryDir),
        h('p', { role: 'status' }, normalizationLabel, normalization.model ? ` · ${normalization.model}` : '',
          normalization.changed ? ' · 来源已有变化，请重新整理。' : ''),
        h('p', { style: { fontSize: '14px' } }, '本次使用的 DSH 默认模型：', state.defaultModel || '尚未配置'),
        button('让 AI 整理人设', () => action({ action: 'prepare', ...sourceInput }), state.pendingUncertain || !state.sourceComplete),
        h('p', { style: { fontSize: '14px' } }, '整理会使用 DSH 当前默认模型并产生相应调用费用。相同输入会复用已保存的结果；缺失信息留空，整理失败时不注册。'),
        h('details', null, h('summary', null, state.binding ? '查看与调整 7 项属性' : '查看 AI 整理的 7 项属性'),
          !state.binding && h('p', { style: { fontSize: '14px' } }, '首次接入若要调整结果，请修改上方原文后重新整理；未提及的可选属性留空。'),
          ...Object.entries(fields).map(([key, label]) => h('div', { key }, field(label, form.draft.overrides?.[key],
            (value) => edit((old) => ({ ...old, draft: { ...old.draft, overrides: { ...old.draft.overrides, [key]: value } } })), false, !state.binding),
            normalization.evidence?.[key] && h('small', { style: { display: 'block' } }, 'AI 整理时的原文依据（不随手工修改变化）：', normalization.evidence[key])))),
        !state.enabled && button(state.sourceComplete ? '确认范围，让 AI 整理并接入' : '启用，铸魂完成后自动整理并接入',
          () => action({ action: 'configure', ...sourceInput, enabled: true })),
        state.enabled && button('暂停自动接入', () => action({ action: 'configure', enabled: false })),
        state.pairing && h('div', { style: { margin: '16px 0', padding: '16px', border: '1px solid #888', borderRadius: '10px' } },
          h('strong', null, '配对码：', state.pairing.userCode),
          h('p', null, '在社区确认伙伴资料，并批准“同步人设”权限。批准后插件会自动导入上述人设。'),
          h('a', { href: state.pairing.connectUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: '18px' } }, '打开平台，注册或绑定伙伴')),
        state.binding && h('p', null, '已绑定：', state.binding.actorName || state.binding.actorId, ' · ID ', state.binding.actorId, ' · 人设版本 ', state.binding.revision ?? '尚未导入'),
        state.changed && h('p', { role: 'status' }, '本地人设已变化。平台尚未自动覆盖；请核对上面的最新内容后提交更新。'),
        state.pendingUncertain && h('p', { role: 'status' }, '上一笔提交结果尚未确认。请先重试原请求；确认结果后才能换用新内容。'),
        state.binding && button(state.pendingImport ? '重试原同步请求' : '检查绑定状态', () => action({ action: 'sync' })),
        state.binding && button('确认以上内容，更新平台人设', () => action({ action: 'sync', fresh: true, draft: form.draft }), !state.sourceComplete || state.pendingUncertain || normalization.status !== 'ready'),
        state.enabled && !state.binding && !state.pairing && button('重试整理与连接', () => action({ action: 'configure', ...sourceInput, enabled: true })),
        (state.platformUrl || form.platformUrl) && button('更换社区 / 重新配对', () => {
          const target = form.platformUrl.trim() || state.platformUrl;
          if (window.confirm(`更换社区 / 重新配对：\n${state.platformUrl || '尚未设置'} → ${target}\n\n将停止旧的本机连接，保留社区账号、人设和页面中尚未提交的编辑。旧平台授权仍需在原平台撤销。\n\n这一步不会立即连接任一平台，之后请核对人设并确认接入。继续吗？`)) {
            void action({ action: 'reconnect', platformUrl: target });
          }
        }, !supportsConnectionSwitch || state.pendingUncertain),
        edited && h('p', null, '有尚未提交的修改。'),
        h('p', { style: { fontSize: '14px' } }, '仅首次接入会自动同步；后续人设变化由你确认更新。若其他程序占用 AI 控制权，本插件会等待你结束该程序后重试，不会抢占。授权仅保存在本机插件状态文件，不显示给网页。'));
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'tangui-registration', order: 110,
        label: () => '碳硅派对' }, Section));
    } };
  },
});

