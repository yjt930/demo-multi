/**
 * pin-comments.js — 多人评论层 (v0.4, Supabase + projectKey + 项目级清单)
 *
 * 用途：在任意 HTML demo 页面以一行 <script> 引入，即可获得「在画布上贴 Pin 评论」的能力。
 * 数据：评论数据存于 Supabase；localStorage 仅保存当前浏览器昵称、上次抽屉视图。
 *
 * 配置：在引入本脚本前定义 window.PIN_COMMENTS = { url, anonKey, projectKey, pageKey?, pageTitle? }
 *   - url:        Supabase Project URL，必填
 *   - anonKey:    Supabase anon public key，必填
 *   - projectKey: 项目隔离键，必填。同一项目所有页面共享一个值，例如 'feixiang-ai'
 *   - pageKey:    页面隔离键，可选。默认 location.pathname 规整后的值
 *   - pageTitle:  页面可读名（写入数据库，用于跨页清单展示），可选。默认 document.title
 *
 * 交互：
 *   - 右下角浮动按钮：开/关「评论模式」、打开「评论清单抽屉」、隐藏/显示已有 Pin
 *   - 评论模式 ON：元素 hover 高亮 + 点击创建草稿 Pin（点发送才落库）
 *   - Pin：点击展开评论卡片，可回复、改状态（待修改/已修改/已确认/不做）
 *   - 抽屉：上排切「本页 / 全项目」视图（默认 全项目），下排按状态筛选；
 *           点击列表项跳转到对应位置；跨页跳转走 `?pc=<pinId>` 查询参数，落地页自动打开卡片。
 *   - 一键导出 Markdown（按当前视图导出本页 / 全项目）
 *
 * v0.4 新增：
 *   - 抽屉清单展示同一 projectKey 下所有页面的评论
 *   - 列表项展示来源页面标题，点击可跨页跳转
 *   - 顶部筛选样式重构（segmented，参考 v28 cv-tab 风格）
 *   - FAB 徽章只显示本页计数，避免被全项目数量吓到
 */
(function () {
    'use strict';

    // ============= 配置 & 常量 =============
    // 兼容旧名 PIN_COMMENTS_SUPABASE，但优先使用 PIN_COMMENTS
    const CONFIG = window.PIN_COMMENTS || window.PIN_COMMENTS_SUPABASE || {};
    const PROJECT_KEY = (CONFIG.projectKey || '').trim();
    // 默认 PAGE_KEY 取文件名（不带路径前缀）。
    // 这样同一页面在「本地 dev server / GitHub Pages（带仓库名前缀）/ file:// 直接打开」
    // 三种环境下 page_key 一致，评论不会分裂、跨页跳转用相对解析也不会 404。
    // 用户也可显式指定 CONFIG.pageKey 覆盖（自负一致性责任）。
    function defaultPageKey() {
        const explicit = CONFIG.pageKey && String(CONFIG.pageKey).trim();
        if (explicit) return explicit;
        const last = (location.pathname.split('/').filter(Boolean).pop() || '').trim();
        return last || 'index';
    }
    const PAGE_KEY = defaultPageKey();
    // 页面可读标题：默认 document.title，可被 CONFIG.pageTitle 覆盖
    const PAGE_TITLE = (CONFIG.pageTitle && String(CONFIG.pageTitle).trim())
        || (document.title || '').trim()
        || PAGE_KEY;
    const NICK_KEY = 'pc::nickname';
    const VIEW_KEY = 'pc::view'; // 'page' | 'project'

    if (!PROJECT_KEY) {
        console.warn('[pin-comments] 缺少 projectKey，多人评论已禁用。请在引入脚本前设置 window.PIN_COMMENTS = { url, anonKey, projectKey }');
    }

    const supabaseClient = (window.supabase && CONFIG.url && CONFIG.anonKey && PROJECT_KEY)
        ? window.supabase.createClient(CONFIG.url, CONFIG.anonKey)
        : null;

    const STATUS = {
        todo:      { label: '待修改', color: '#F59E0B', bg: '#FEF3C7' },
        fixed:     { label: '已修改', color: '#10B981', bg: '#D1FAE5' },
        confirmed: { label: '已确认', color: '#6366F1', bg: '#E0E7FF' },
        wontfix:   { label: '不做',   color: '#9CA3AF', bg: '#F3F4F6' }
    };

    const uid = () => 'p_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
    const fmt = (ts) => {
        const d = new Date(ts), now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        const pad = (n) => String(n).padStart(2, '0');
        if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    // 生成稳定的元素选择器
    function getSelector(el) {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        const path = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body && path.length < 8) {
            let part = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
                const sib = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                if (sib.length > 1) part += `:nth-of-type(${sib.indexOf(cur) + 1})`;
            }
            path.unshift(part);
            cur = parent;
        }
        return 'body > ' + path.join(' > ');
    }

    function findEl(selector) {
        try { return document.querySelector(selector); } catch (e) { return null; }
    }

    // ============= Supabase 存储 =============
    function isCloudReady() {
        return !!supabaseClient;
    }

    function toPin(row) {
        const comments = (row.comment_messages || [])
            .slice()
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .map(msg => ({
                id: msg.id,
                author: msg.author,
                body: msg.body,
                ts: msg.created_at
            }));
        return {
            id: row.id,
            pageKey: row.page_key,
            pageTitle: (row.page_title && String(row.page_title).trim()) || row.page_key,
            selector: row.selector,
            xPct: row.x_pct,
            yPct: row.y_pct,
            isFixed: row.is_fixed,
            status: row.status,
            createdAt: row.created_at,
            createdBy: row.created_by,
            comments
        };
    }

    // 拉取整个 projectKey 下所有页面的 pin（v0.4 起改为项目级）
    // selector 只在当前页有效，所以画布只画 PAGE_KEY 的 pin；抽屉里全量展示。
    async function fetchPins() {
        if (!isCloudReady()) return [];
        const { data, error } = await supabaseClient
            .from('comment_pins')
            .select('id, page_key, page_title, selector, x_pct, y_pct, is_fixed, status, created_at, created_by, comment_messages(id, author, body, created_at)')
            .eq('project_key', PROJECT_KEY)
            .order('created_at', { ascending: true });
        if (error) throw error;
        return (data || [])
            .map(toPin)
            .filter(pin => pin.comments.length > 0);
    }

    async function refreshFromCloud(quiet) {
        if (!isCloudReady()) {
            if (!quiet) showToast('未连接 Supabase，多人评论不可用');
            return;
        }
        try {
            pins = await fetchPins();
            refreshAllUi();
        } catch (err) {
            console.error('[pin-comments] load failed', err);
            if (!quiet) showToast('评论同步失败，请检查 Supabase 配置');
        }
    }

    function scheduleCloudRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refreshFromCloud(true), 120);
    }

    function setupRealtime() {
        if (!isCloudReady() || realtimeChannel) return;
        // 项目级订阅：同一 projectKey 下任何页面变更都触发刷新
        realtimeChannel = supabaseClient
            .channel(`pin-comments:${PROJECT_KEY}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'comment_pins',
                filter: `project_key=eq.${PROJECT_KEY}`
            }, scheduleCloudRefresh)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'comment_messages',
                filter: `project_key=eq.${PROJECT_KEY}`
            }, scheduleCloudRefresh)
            .subscribe(status => {
                if (status === 'CHANNEL_ERROR') {
                    showToast('实时同步连接失败，请检查 Supabase Realtime');
                }
            });
    }

    async function insertPin(pin) {
        const { data, error } = await supabaseClient
            .from('comment_pins')
            .insert({
                id: pin.id,
                project_key: PROJECT_KEY,
                page_key: PAGE_KEY,
                page_title: PAGE_TITLE,
                selector: pin.selector,
                x_pct: pin.xPct,
                y_pct: pin.yPct,
                is_fixed: pin.isFixed,
                status: pin.status,
                created_by: pin.createdBy
            })
            .select('id, page_key, page_title, selector, x_pct, y_pct, is_fixed, status, created_at, created_by, comment_messages(id, author, body, created_at)')
            .single();
        if (error) throw error;
        return toPin(data);
    }

    async function insertComment(pinId, body) {
        const { data, error } = await supabaseClient
            .from('comment_messages')
            .insert({
                pin_id: pinId,
                project_key: PROJECT_KEY,
                page_key: PAGE_KEY,
                author: getNick(),
                body
            })
            .select('id, author, body, created_at')
            .single();
        if (error) throw error;
        return { id: data.id, author: data.author, body: data.body, ts: data.created_at };
    }

    async function updatePinStatus(pinId, status) {
        const { error } = await supabaseClient
            .from('comment_pins')
            .update({ status })
            .eq('id', pinId)
            .eq('project_key', PROJECT_KEY);
        if (error) throw error;
    }

    async function deletePin(pinId) {
        const { error } = await supabaseClient
            .from('comment_pins')
            .delete()
            .eq('id', pinId)
            .eq('project_key', PROJECT_KEY);
        if (error) throw error;
    }

    function getNick() {
        return localStorage.getItem(NICK_KEY) || '';
    }
    function setNick(n) {
        localStorage.setItem(NICK_KEY, n);
    }
    function getView() {
        const v = localStorage.getItem(VIEW_KEY);
        return v === 'page' || v === 'project' ? v : 'project'; // 默认全项目
    }
    function setView(v) {
        localStorage.setItem(VIEW_KEY, v);
    }

    // ============= 状态 =============
    let pins = []; // 整个 projectKey 下所有页面的 pin
    let isCommentMode = false;
    let drawerOpen = false;
    let activePinId = null;
    let filterStatus = 'all';
    let viewScope = getView(); // 'page' | 'project'
    let realtimeChannel = null;
    let refreshTimer = null;
    let hoverTarget = null;
    let pinsHidden = false;
    let activeDraft = null;

    // 当前页 pin（用于画布渲染、FAB 计数、本页编号）
    function pagePins() {
        return pins.filter(p => p.pageKey === PAGE_KEY);
    }
    function isCurrentPage(pin) {
        return pin.pageKey === PAGE_KEY;
    }

    // ============= 样式注入 =============
    const css = `
    /* FAB：三个统一圆 icon 按钮，垂直排列 */
    .pc-fab-wrap{position:fixed;right:20px;bottom:76px;z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:flex-end;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
    .pc-fab-btn{position:relative;width:38px;height:38px;border-radius:50%;background:#fff;color:#374151;border:1px solid #E5E7EB;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 12px -4px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.04);font-size:16px;line-height:1;padding:0;transition:transform .15s, border-color .15s, background .15s, color .15s}
    .pc-fab-btn:hover{transform:translateY(-1px);border-color:#D1D5DB;background:#FAFAFA}
    .pc-fab-btn.on{background:#2563EB;border-color:#2563EB;color:#fff}
    .pc-fab-btn.on:hover{background:#1D4ED8;border-color:#1D4ED8}
    .pc-fab-btn.muted{color:#9CA3AF;background:#F9FAFB}
    .pc-fab-btn.muted:hover{color:#6B7280}
    .pc-fab-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#F59E0B;color:#fff;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px #fff;line-height:1}
    .pc-fab-badge.show{display:inline-flex}

    /* 自定义 tooltip：黑底白字小气泡 + kbd 键盘按键 chip */
    .pc-tooltip{position:fixed;z-index:100001;background:#1F2937;color:#fff;font-size:12px;line-height:1.4;padding:6px 10px;border-radius:6px;box-shadow:0 6px 18px -4px rgba(0,0,0,0.35);font-family:inherit;font-weight:500;letter-spacing:.01em;display:inline-flex;align-items:center;gap:8px;pointer-events:none;opacity:0;transform:translateX(4px);transition:opacity .12s ease, transform .12s ease;white-space:nowrap}
    .pc-tooltip.show{opacity:1;transform:translateX(0)}
    .pc-tooltip::after{content:"";position:absolute;top:50%;right:-4px;width:8px;height:8px;background:#1F2937;transform:translateY(-50%) rotate(45deg);border-radius:1px}
    .pc-tooltip-text{font-weight:500}
    .pc-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;background:rgba(255,255,255,0.16);color:#F3F4F6;border:1px solid rgba(255,255,255,0.18);border-bottom-width:2px;border-radius:4px;font-size:10.5px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,"SF Mono","Monaco","Consolas",monospace;letter-spacing:0;line-height:1}
    .pc-kbd-sep{color:rgba(255,255,255,0.45);font-size:10px;margin:0 1px}

    body.pc-mode-on{user-select:none;cursor:crosshair}
    body.pc-mode-on .pc-hover-target{outline:2px dashed rgba(37,99,235,.55) !important;outline-offset:2px;cursor:crosshair !important}

    .pc-pin{position:absolute;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#2563EB;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;cursor:pointer;box-shadow:0 4px 12px -2px rgba(0,0,0,0.25);z-index:99990;transition:transform .15s ease, box-shadow .15s ease;border:2px solid #fff}
    .pc-pin span{transform:rotate(45deg);display:block;line-height:1}
    .pc-pin:hover{transform:rotate(-45deg) scale(1.1)}
    .pc-pin.flash{animation:pcFlash 1.2s ease-out}
    .pc-pin.fixed-pos{position:fixed}
    .pc-pin.draft{background:#111827;border-color:#FCD34D;opacity:.95}
    @keyframes pcFlash{0%,100%{box-shadow:0 4px 12px -2px rgba(0,0,0,0.25)}50%{box-shadow:0 0 0 8px rgba(37,99,235,0.35), 0 4px 12px -2px rgba(0,0,0,0.25)}}

    .pc-card{position:absolute;width:320px;background:#fff;border-radius:14px;border:1px solid #E5E7EB;box-shadow:0 20px 50px -12px rgba(0,0,0,0.25);z-index:99995;overflow:hidden;font-size:13px;color:#1F2937}
    .pc-card.fixed-pos{position:fixed}
    .pc-card-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #F3F4F6;background:#FAFAFA}
    .pc-card-head .pc-status-pill{padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;border:none}
    .pc-card-head .pc-close{background:transparent;border:none;cursor:pointer;color:#9CA3AF;font-size:16px;padding:0;line-height:1;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px}
    .pc-card-head .pc-close:hover{background:#F3F4F6;color:#111}
    .pc-status-menu{position:absolute;top:42px;left:14px;background:#fff;border:1px solid #E5E7EB;border-radius:8px;box-shadow:0 10px 24px -8px rgba(0,0,0,0.2);padding:4px;z-index:1;min-width:120px}
    .pc-status-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:none;background:transparent;cursor:pointer;font-size:12px;border-radius:6px;text-align:left;color:#1F2937}
    .pc-status-menu button:hover{background:#F3F4F6}
    .pc-status-menu .dot{width:8px;height:8px;border-radius:50%}

    .pc-card-body{max-height:280px;overflow-y:auto;padding:10px 14px}
    .pc-comment{padding:8px 0;border-bottom:1px dashed #F3F4F6}
    .pc-comment:last-child{border-bottom:none}
    .pc-comment-meta{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11px;color:#6B7280}
    .pc-comment-meta .pc-author{font-weight:600;color:#111827}
    .pc-comment-body{font-size:13px;line-height:1.55;color:#1F2937;white-space:pre-wrap;word-break:break-word}
    .pc-card-input{padding:10px 14px;border-top:1px solid #F3F4F6;background:#FAFAFA}
    .pc-card-input textarea{width:100%;border:1px solid #E5E7EB;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;resize:none;outline:none;box-sizing:border-box;background:#fff}
    .pc-card-input textarea:focus{border-color:#2563EB}
    .pc-card-input .pc-actions{display:flex;justify-content:space-between;align-items:center;margin-top:6px}
    .pc-card-input .pc-hint{font-size:11px;color:#9CA3AF}
    .pc-btn{padding:6px 12px;border-radius:6px;border:none;font-size:12px;font-weight:600;cursor:pointer}
    .pc-btn-primary{background:#2563EB;color:#fff}
    .pc-btn-primary:hover{background:#1D4ED8}
    .pc-btn-primary:disabled{background:#D1D5DB;cursor:not-allowed}
    .pc-btn-ghost{background:transparent;color:#6B7280}
    .pc-btn-danger{background:transparent;color:#DC2626;font-size:11px}

    .pc-drawer-mask{position:fixed;inset:0;background:rgba(0,0,0,0.2);z-index:99996;opacity:0;pointer-events:none;transition:opacity .2s}
    .pc-drawer-mask.show{opacity:1;pointer-events:auto}
    .pc-drawer{position:fixed;top:0;right:0;bottom:0;width:400px;background:#fff;z-index:99997;box-shadow:-10px 0 30px -10px rgba(0,0,0,0.15);transform:translateX(100%);transition:transform .25s cubic-bezier(0.2,0.8,0.2,1);display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    .pc-drawer.show{transform:translateX(0)}

    /* 头部：标题 + 视图 dropdown + 关闭 同一行；状态 chip 第二行 */
    .pc-drawer-head{padding:12px 14px 8px;border-bottom:1px solid #F3F4F6;background:#FAFAFA;position:relative}
    .pc-drawer-head .pc-title{font-size:14px;font-weight:700;color:#111827;display:flex;align-items:center;gap:8px;letter-spacing:-.005em}
    .pc-drawer-head .pc-title-text{flex-shrink:0}
    .pc-drawer-head .pc-close-x{margin-left:auto;background:transparent;border:none;font-size:16px;cursor:pointer;color:#9CA3AF;width:24px;height:24px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1}
    .pc-drawer-head .pc-close-x:hover{background:#F3F4F6;color:#111827}

    /* 视图 dropdown：触发器扁平 chip，菜单浮层 */
    .pc-view-dd{position:relative;font-weight:500}
    .pc-view-trigger{display:inline-flex;align-items:center;gap:4px;padding:4px 8px 4px 10px;border:1px solid #E5E7EB;background:#fff;border-radius:6px;font-size:12px;color:#1F2937;cursor:pointer;font-weight:500;font-family:inherit;transition:border-color .15s, background .15s;line-height:1.4;letter-spacing:.005em}
    .pc-view-trigger:hover{border-color:#D1D5DB;background:#FAFAFA}
    .pc-view-trigger.open{border-color:#D97706;background:#FEF3C7;color:#92400E}
    .pc-view-trigger .pc-view-meta{color:#9CA3AF;font-weight:400;font-variant-numeric:tabular-nums;margin-left:2px}
    .pc-view-trigger.open .pc-view-meta{color:#D97706}
    .pc-view-trigger .pc-caret{font-size:9px;color:#9CA3AF;margin-left:2px;transition:transform .15s}
    .pc-view-trigger.open .pc-caret{transform:rotate(180deg);color:#D97706}

    .pc-view-menu{position:absolute;top:calc(100% + 4px);left:0;min-width:160px;background:#fff;border:1px solid #E5E7EB;border-radius:8px;box-shadow:0 12px 28px -10px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.04);padding:4px;z-index:100000;display:none}
    .pc-view-menu.show{display:block}
    .pc-view-option{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;background:transparent;cursor:pointer;font-size:12.5px;border-radius:6px;text-align:left;color:#1F2937;font-family:inherit;font-weight:500;transition:background .12s}
    .pc-view-option:hover{background:#F3F4F6}
    .pc-view-option.active{color:#92400E;background:#FEF3C7}
    .pc-view-option .pc-vo-meta{margin-left:auto;color:#9CA3AF;font-variant-numeric:tabular-nums;font-weight:400;font-size:11px}
    .pc-view-option.active .pc-vo-meta{color:#D97706}
    .pc-view-option .pc-vo-check{width:12px;height:12px;display:inline-flex;align-items:center;justify-content:center;color:#D97706;font-size:11px;flex-shrink:0;visibility:hidden}
    .pc-view-option.active .pc-vo-check{visibility:visible}

    /* 状态筛选：紧凑 chip，0 数字隐藏 + 字色变浅 */
    .pc-drawer-head .pc-filters{display:flex;gap:1px;margin-top:8px;flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch}
    .pc-drawer-head .pc-filters::-webkit-scrollbar{display:none}
    .pc-filter{display:inline-flex;align-items:center;gap:3px;padding:4px 8px;border-radius:6px;border:none;background:transparent;font-size:11.5px;color:#6B7280;cursor:pointer;font-weight:500;transition:background .15s, color .15s;letter-spacing:.005em;white-space:nowrap;font-family:inherit}
    .pc-filter:hover{background:#fff;color:#111827}
    .pc-filter.active{background:#FEF3C7;color:#92400E;font-weight:600}
    .pc-filter.empty{color:#B5BAC1}
    .pc-filter.empty:hover{color:#6B7280}
    .pc-filter .pc-filter-meta{color:#9CA3AF;font-weight:400;font-variant-numeric:tabular-nums}
    .pc-filter.active .pc-filter-meta{color:#D97706}

    .pc-drawer-body{flex:1;overflow-y:auto;padding:8px 12px 80px}
    .pc-list-item{padding:11px 12px;border-radius:10px;cursor:pointer;border:1px solid transparent;margin-bottom:4px;transition:all .15s}
    .pc-list-item:hover{background:#F9FAFB;border-color:#E5E7EB}
    .pc-list-item .pc-li-head{display:flex;align-items:center;gap:7px;font-size:11px;color:#6B7280;margin-bottom:5px;flex-wrap:wrap}
    .pc-list-item .pc-li-num{width:18px;height:18px;border-radius:4px;background:#2563EB;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-variant-numeric:tabular-nums}
    .pc-list-item.cross-page .pc-li-num{background:#9CA3AF}
    .pc-list-item .pc-li-status{padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;flex-shrink:0}
    .pc-list-item .pc-li-page{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;background:#F3F4F6;color:#4B5563;font-size:10px;font-weight:500;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pc-list-item .pc-li-page::before{content:"📄";font-size:9px;flex-shrink:0;filter:grayscale(.4)}
    .pc-list-item.cross-page .pc-li-page{background:#FEF3C7;color:#92400E}
    .pc-list-item.cross-page .pc-li-page::before{content:"↗";font-style:normal;filter:none}
    .pc-list-item .pc-li-body{font-size:13px;color:#1F2937;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
    .pc-list-item .pc-li-foot{font-size:11px;color:#9CA3AF;margin-top:6px;display:flex;justify-content:space-between;font-variant-numeric:tabular-nums}
    .pc-empty{text-align:center;padding:60px 20px;color:#9CA3AF;font-size:13px;line-height:1.6}
    .pc-drawer-foot{position:absolute;bottom:0;left:0;right:0;padding:10px 16px;background:#fff;border-top:1px solid #F3F4F6;display:flex;gap:8px;justify-content:space-between;align-items:center}
    .pc-drawer-foot .pc-nick{font-size:11px;color:#6B7280}
    .pc-drawer-foot .pc-nick b{color:#111827;font-weight:600}

    .pc-toast{position:fixed;bottom:136px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:99999;opacity:0;transition:opacity .2s, transform .2s;pointer-events:none}
    .pc-toast.show{opacity:1;transform:translateX(-50%) translateY(-4px)}

    .pc-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:99998;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    .pc-modal{background:#fff;border-radius:14px;padding:24px;width:320px;box-shadow:0 20px 50px -10px rgba(0,0,0,0.3)}
    .pc-modal h3{margin:0 0 6px;font-size:16px;font-weight:700;color:#111827}
    .pc-modal p{margin:0 0 16px;font-size:13px;color:#6B7280;line-height:1.5}
    .pc-modal input{width:100%;padding:10px 12px;border:1px solid #E5E7EB;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box}
    .pc-modal input:focus{border-color:#2563EB}
    .pc-modal .pc-modal-actions{display:flex;justify-content:flex-end;margin-top:14px;gap:8px}
    `;

    // ============= UI 创建 =============
    let fabBtn, pinToggleBtn, drawerEl, maskEl, pinLayer;

    function injectStyle() {
        const s = document.createElement('style');
        s.textContent = css;
        s.className = 'pc-ui';
        document.head.appendChild(s);
    }

    // ============= 自定义 tooltip（hover 露出快捷键）=============
    let tooltipEl = null;
    let tooltipShowTimer = null;
    let tooltipHideTimer = null;
    let tooltipCurrentTarget = null;

    function ensureTooltip() {
        if (tooltipEl) return tooltipEl;
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'pc-tooltip pc-ui';
        document.body.appendChild(tooltipEl);
        return tooltipEl;
    }

    // 渲染 tooltip 内容：text + 1~2 个 kbd（用 / 分隔）
    function renderTooltipContent(text, keys) {
        const safe = escapeHtml(text || '');
        let kbdHtml = '';
        if (keys && keys.length) {
            kbdHtml = keys.map((k, i) => {
                const sep = i > 0 ? '<span class="pc-kbd-sep">/</span>' : '';
                return `${sep}<span class="pc-kbd">${escapeHtml(k)}</span>`;
            }).join('');
        }
        return `<span class="pc-tooltip-text">${safe}</span>${kbdHtml}`;
    }

    // 把 tooltip 定位在目标元素左侧居中（FAB 在右下角，往左展开）
    function positionTooltipLeftOf(target) {
        const tip = ensureTooltip();
        const r = target.getBoundingClientRect();
        // 临时显示以测量尺寸
        tip.style.visibility = 'hidden';
        tip.classList.add('show');
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        tip.classList.remove('show');
        tip.style.visibility = '';
        const top = r.top + (r.height - th) / 2;
        const left = r.left - tw - 10;
        tip.style.top = Math.max(8, top) + 'px';
        tip.style.left = Math.max(8, left) + 'px';
    }

    function showTooltipFor(target) {
        const tip = ensureTooltip();
        const text = target.getAttribute('data-pc-tip') || '';
        const keysAttr = target.getAttribute('data-pc-keys') || '';
        const keys = keysAttr ? keysAttr.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!text && !keys.length) return;
        tip.innerHTML = renderTooltipContent(text, keys);
        positionTooltipLeftOf(target);
        clearTimeout(tooltipHideTimer);
        tip.classList.add('show');
    }

    function hideTooltip() {
        if (!tooltipEl) return;
        tooltipEl.classList.remove('show');
    }

    // 全局事件代理：任何 .pc-ui 元素带 data-pc-tip 都生效
    function bindTooltipEvents() {
        document.addEventListener('mouseover', (e) => {
            const t = e.target.closest && e.target.closest('[data-pc-tip]');
            if (!t || !t.classList.contains('pc-ui')) return;
            if (t === tooltipCurrentTarget) return;
            tooltipCurrentTarget = t;
            clearTimeout(tooltipShowTimer);
            tooltipShowTimer = setTimeout(() => showTooltipFor(t), 250);
        }, true);
        document.addEventListener('mouseout', (e) => {
            const t = e.target.closest && e.target.closest('[data-pc-tip]');
            if (!t) return;
            // 鼠标离开元素本体（不是进入子元素）
            if (e.relatedTarget && t.contains(e.relatedTarget)) return;
            clearTimeout(tooltipShowTimer);
            if (t === tooltipCurrentTarget) tooltipCurrentTarget = null;
            tooltipHideTimer = setTimeout(hideTooltip, 80);
        }, true);
        // 任何点击都立即关掉 tooltip（避免按钮按完气泡还赖着）
        document.addEventListener('click', () => {
            clearTimeout(tooltipShowTimer);
            tooltipCurrentTarget = null;
            hideTooltip();
        }, true);
    }

    // ============= SVG icons (lucide 风格) =============
    const ICONS = {
        comment: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        cursor:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m13 13 6 6"/><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>',
        list:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>',
        eye:     '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
        eyeOff:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>'
    };

    function createFab() {
        const wrap = document.createElement('div');
        wrap.className = 'pc-fab-wrap pc-ui';

        // 评论模式（C）—— 主按钮，带右上角徽章
        fabBtn = document.createElement('button');
        fabBtn.className = 'pc-fab-btn pc-ui';
        fabBtn.type = 'button';
        fabBtn.innerHTML = `<span class="pc-fab-icon"></span><span class="pc-fab-badge"></span>`;
        fabBtn.onclick = toggleCommentMode;

        // 评论清单（L）
        const list = document.createElement('button');
        list.className = 'pc-fab-btn pc-ui';
        list.type = 'button';
        list.setAttribute('data-pc-tip', '评论清单');
        list.setAttribute('data-pc-keys', 'L');
        list.innerHTML = ICONS.list;
        list.onclick = () => toggleDrawer(!drawerOpen);

        // 隐藏/显示 Pin（H）
        pinToggleBtn = document.createElement('button');
        pinToggleBtn.className = 'pc-fab-btn pc-ui';
        pinToggleBtn.type = 'button';
        pinToggleBtn.onclick = togglePinsHidden;

        wrap.appendChild(fabBtn);
        wrap.appendChild(list);
        wrap.appendChild(pinToggleBtn);
        document.body.appendChild(wrap);
    }

    function refreshFab() {
        if (!fabBtn) return;
        // FAB 徽章只显示本页待修改数（0 时隐藏徽章，避免视觉噪音）
        const local = pagePins();
        const open = local.filter(p => p.status === 'todo').length;
        const iconSlot = fabBtn.querySelector('.pc-fab-icon');
        const badge = fabBtn.querySelector('.pc-fab-badge');
        if (iconSlot) iconSlot.innerHTML = isCommentMode ? ICONS.cursor : ICONS.comment;
        if (badge) {
            badge.textContent = open > 99 ? '99+' : String(open);
            badge.classList.toggle('show', open > 0 && !isCommentMode);
        }
        fabBtn.classList.toggle('on', isCommentMode);
        if (isCommentMode) {
            fabBtn.setAttribute('data-pc-tip', '退出评论模式');
            fabBtn.setAttribute('data-pc-keys', 'V,Esc');
        } else {
            fabBtn.setAttribute('data-pc-tip', open > 0 ? `进入评论模式 · 本页 ${open} 条待修改` : '进入评论模式');
            fabBtn.setAttribute('data-pc-keys', 'C');
        }

        if (pinToggleBtn) {
            pinToggleBtn.setAttribute('data-pc-tip', pinsHidden ? '显示本页 Pin' : '隐藏本页 Pin');
            pinToggleBtn.setAttribute('data-pc-keys', 'H');
            pinToggleBtn.innerHTML = pinsHidden ? ICONS.eyeOff : ICONS.eye;
            pinToggleBtn.classList.toggle('muted', pinsHidden);
        }
    }

    function createPinLayer() {
        pinLayer = document.createElement('div');
        pinLayer.className = 'pc-ui';
        pinLayer.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:99989;pointer-events:none';
        document.body.appendChild(pinLayer);
    }

    function showToast(msg) {
        const t = document.createElement('div');
        t.className = 'pc-toast pc-ui';
        t.textContent = msg;
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
    }

    function refreshAllUi() {
        renderPins();
        refreshFab();
        if (drawerOpen) renderDrawer();
        if (pinsHidden && activePinId) {
            closeActiveCard();
            return;
        }
        if (activePinId && activeCard) {
            const pin = pins.find(p => p.id === activePinId);
            if (pin) {
                renderCard(activeCard, pin);
                const pinEl = pinLayer.querySelector(`[data-id="${activePinId}"]`);
                if (pinEl) positionCard(activeCard, pinEl, pin.isFixed);
            } else {
                closeActiveCard();
            }
        }
    }

    function togglePinsHidden() {
        pinsHidden = !pinsHidden;
        if (pinsHidden) closeActiveCard();
        renderPins();
        refreshFab();
        showToast(pinsHidden ? '已隐藏页面 Pin，评论清单仍可查看' : '已显示页面 Pin');
    }

    // ============= 昵称弹窗 =============
    function ensureNickname(cb) {
        if (getNick()) return cb();
        const mask = document.createElement('div');
        mask.className = 'pc-modal-mask pc-ui';
        mask.innerHTML = `
            <div class="pc-modal">
                <h3>留个名字吧</h3>
                <p>评论会显示你的名字，方便过稿时对齐。</p>
                <input type="text" placeholder="例如：邓 / 设计-小李 / QA-阿强" maxlength="20"/>
                <div class="pc-modal-actions">
                    <button class="pc-btn pc-btn-primary">开始评论</button>
                </div>
            </div>`;
        document.body.appendChild(mask);
        const input = mask.querySelector('input');
        const btn = mask.querySelector('button');
        input.focus();
        const submit = () => {
            const v = input.value.trim();
            if (!v) { input.focus(); return; }
            setNick(v);
            mask.remove();
            cb();
        };
        btn.onclick = submit;
        input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    }

    // ============= 评论模式切换 =============
    function toggleCommentMode() {
        if (!isCloudReady()) {
            showToast('未连接 Supabase，多人评论不可用');
            return;
        }
        if (!isCommentMode) {
            ensureNickname(() => {
                isCommentMode = true;
                document.body.classList.add('pc-mode-on');
                refreshFab();
                showToast('评论模式：点击页面任意位置落 Pin');
            });
        } else {
            isCommentMode = false;
            document.body.classList.remove('pc-mode-on');
            setHoverTarget(null);
            refreshFab();
            closeActiveCard();
        }
    }

    function setHoverTarget(el) {
        if (hoverTarget === el) return;
        if (hoverTarget) hoverTarget.classList.remove('pc-hover-target');
        hoverTarget = el;
        if (hoverTarget) hoverTarget.classList.add('pc-hover-target');
    }

    document.addEventListener('mouseover', (e) => {
        if (!isCommentMode || e.target.closest('.pc-ui')) {
            setHoverTarget(null);
            return;
        }
        setHoverTarget(e.target);
    }, true);

    // ============= 落 Pin =============
    document.addEventListener('click', async (e) => {
        if (!isCommentMode) return;
        if (e.target.closest('.pc-ui')) return;
        e.preventDefault();
        e.stopPropagation();
        if (!isCloudReady()) {
            showToast('未连接 Supabase，多人评论不可用');
            return;
        }

        const target = e.target;
        const rect = target.getBoundingClientRect();
        const xPct = (e.clientX - rect.left) / Math.max(rect.width, 1);
        const yPct = (e.clientY - rect.top) / Math.max(rect.height, 1);
        const isFixed = isFixedAncestor(target);

        const pin = {
            id: uid(),
            selector: getSelector(target),
            xPct, yPct,
            isFixed,
            status: 'todo',
            createdAt: new Date().toISOString(),
            createdBy: getNick(),
            comments: []
        };
        openDraftCard(pin, true);
    }, true);

    function isFixedAncestor(el) {
        let cur = el;
        while (cur && cur !== document.body) {
            const pos = getComputedStyle(cur).position;
            if (pos === 'fixed' || pos === 'sticky') return true;
            cur = cur.parentElement;
        }
        return false;
    }

    // ============= Pin 渲染（仅当前页） =============
    function renderPins() {
        if (!pinLayer) return;
        pinLayer.innerHTML = '';
        if (pinsHidden && !activeDraft) return;
        const frag = document.createDocumentFragment();
        if (!pinsHidden) {
            // 本页 pin 才画到画布，按本页内顺序编号
            const local = pagePins();
            local.forEach((p, i) => {
                const el = findEl(p.selector);
                if (!el) return;
                const rect = el.getBoundingClientRect();
                const pinEl = document.createElement('div');
                pinEl.className = 'pc-pin pc-ui' + (p.isFixed ? ' fixed-pos' : '');
                pinEl.dataset.id = p.id;
                pinEl.style.background = STATUS[p.status].color;
                pinEl.innerHTML = `<span>${i + 1}</span>`;
                pinEl.style.pointerEvents = 'auto';

                const localX = p.xPct * rect.width;
                const localY = p.yPct * rect.height;

                if (p.isFixed) {
                    pinEl.style.left = (rect.left + localX - 13) + 'px';
                    pinEl.style.top = (rect.top + localY - 26) + 'px';
                } else {
                    const absX = rect.left + window.scrollX + localX;
                    const absY = rect.top + window.scrollY + localY;
                    pinEl.style.left = (absX - 13) + 'px';
                    pinEl.style.top = (absY - 26) + 'px';
                }

                pinEl.onclick = (e) => {
                    e.stopPropagation();
                    openCard(p.id);
                };
                frag.appendChild(pinEl);
            });
        }
        if (activeDraft && activeDraft.pinEl) frag.appendChild(activeDraft.pinEl);
        pinLayer.appendChild(frag);
    }

    // ============= 评论卡片 =============
    let activeCard = null;
    function closeActiveCard() {
        if (activeCard) { activeCard.remove(); activeCard = null; activePinId = null; }
        if (activeDraft && activeDraft.pinEl) activeDraft.pinEl.remove();
        activeDraft = null;
    }

    function createPinElement(pin, label, isDraft) {
        const el = findEl(pin.selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const pinEl = document.createElement('div');
        pinEl.className = 'pc-pin pc-ui' + (pin.isFixed ? ' fixed-pos' : '') + (isDraft ? ' draft' : '');
        pinEl.dataset.id = pin.id;
        pinEl.innerHTML = `<span>${label}</span>`;
        pinEl.style.pointerEvents = 'auto';

        const localX = pin.xPct * rect.width;
        const localY = pin.yPct * rect.height;
        if (pin.isFixed) {
            pinEl.style.left = (rect.left + localX - 13) + 'px';
            pinEl.style.top = (rect.top + localY - 26) + 'px';
        } else {
            const absX = rect.left + window.scrollX + localX;
            const absY = rect.top + window.scrollY + localY;
            pinEl.style.left = (absX - 13) + 'px';
            pinEl.style.top = (absY - 26) + 'px';
        }
        return pinEl;
    }

    function openDraftCard(pin, autoFocus) {
        closeActiveCard();
        const pinEl = createPinElement(pin, '+', true);
        if (!pinEl) return;
        pinEl.onclick = (e) => {
            e.stopPropagation();
            if (activeDraft && activeDraft.card) activeDraft.card.querySelector('textarea').focus();
        };
        pinLayer.appendChild(pinEl);

        const card = document.createElement('div');
        card.className = 'pc-card pc-ui' + (pin.isFixed ? ' fixed-pos' : '');
        renderDraftCard(card, pin);
        document.body.appendChild(card);
        positionCard(card, pinEl, pin.isFixed);
        activeCard = card;
        activeDraft = { pin, pinEl, card };
        if (autoFocus) {
            const ta = card.querySelector('textarea');
            if (ta) ta.focus();
        }
    }

    function renderDraftCard(card, pin) {
        card.innerHTML = `
            <div class="pc-card-head">
                <button class="pc-status-pill" style="background:#FEF3C7;color:#92400E" disabled>
                    草稿 · 发送后创建
                </button>
                <div style="font-size:11px;color:#9CA3AF">未发布</div>
                <button class="pc-close" data-act="close">✕</button>
            </div>
            <div class="pc-card-body">
                <div style="padding:8px 0;color:#6B7280;font-size:12px;text-align:center">写完并发送后，其他人才会看到这条 Pin。</div>
            </div>
            <div class="pc-card-input">
                <textarea rows="2" placeholder="写评论… (⌘/Ctrl + Enter 发送)" maxlength="500"></textarea>
                <div class="pc-actions">
                    <button class="pc-btn pc-btn-ghost" data-act="cancel">取消</button>
                    <button class="pc-btn pc-btn-primary" data-act="send" disabled>发送</button>
                </div>
            </div>
        `;

        const ta = card.querySelector('textarea');
        const send = card.querySelector('[data-act="send"]');
        ta.oninput = () => { send.disabled = !ta.value.trim(); };
        ta.onkeydown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doSend(); }
        };
        const doSend = async () => {
            const v = ta.value.trim();
            if (!v) return;
            send.disabled = true;
            let savedPin = null;
            try {
                savedPin = await insertPin(pin);
                const msg = await insertComment(savedPin.id, v);
                savedPin.comments.push(msg);
                if (!pins.some(p => p.id === savedPin.id)) pins.push(savedPin);
                closeActiveCard();
                pinsHidden = false;
                refreshAllUi();
                openCard(savedPin.id);
            } catch (err) {
                if (savedPin) {
                    try { await deletePin(savedPin.id); } catch (cleanupErr) { console.warn('[pin-comments] cleanup draft pin failed', cleanupErr); }
                }
                console.error('[pin-comments] create draft failed', err);
                showToast('评论发送失败，请稍后重试');
                send.disabled = false;
            }
        };
        send.onclick = doSend;
        card.querySelector('[data-act="cancel"]').onclick = closeActiveCard;
        card.querySelector('[data-act="close"]').onclick = closeActiveCard;
    }

    function openCard(pinId, autoFocus) {
        closeActiveCard();
        if (pinsHidden) {
            pinsHidden = false;
            renderPins();
            refreshFab();
        }
        const pin = pins.find(p => p.id === pinId);
        if (!pin) return;
        const pinEl = pinLayer.querySelector(`[data-id="${pinId}"]`);
        if (!pinEl) return;
        activePinId = pinId;

        const card = document.createElement('div');
        card.className = 'pc-card pc-ui' + (pin.isFixed ? ' fixed-pos' : '');
        renderCard(card, pin);

        // 定位卡片到 pin 旁边
        document.body.appendChild(card);
        positionCard(card, pinEl, pin.isFixed);
        activeCard = card;
        if (autoFocus) {
            const ta = card.querySelector('textarea');
            if (ta) ta.focus();
        }

        pinEl.classList.add('flash');
        setTimeout(() => pinEl.classList.remove('flash'), 1200);
    }

    function positionCard(card, pinEl, isFixed) {
        const pinRect = pinEl.getBoundingClientRect();
        const cardW = 320, cardH = card.offsetHeight || 200;
        let left = pinRect.right + 12;
        let top = pinRect.top;
        if (left + cardW > window.innerWidth - 10) left = pinRect.left - cardW - 12;
        if (top + cardH > window.innerHeight - 10) top = window.innerHeight - cardH - 10;
        if (top < 10) top = 10;
        if (left < 10) left = 10;
        if (isFixed) {
            card.style.left = left + 'px';
            card.style.top = top + 'px';
        } else {
            card.style.left = (left + window.scrollX) + 'px';
            card.style.top = (top + window.scrollY) + 'px';
        }
    }

    function renderCard(card, pin) {
        const st = STATUS[pin.status];
        // 本页内编号（与画布上 Pin 数字一致）
        const idx = pagePins().findIndex(p => p.id === pin.id);
        const numLabel = idx >= 0 ? `#${idx + 1}` : '#?';
        card.innerHTML = `
            <div class="pc-card-head">
                <button class="pc-status-pill" style="background:${st.bg};color:${st.color}" data-act="status">
                    ${st.label} ▾
                </button>
                <div style="font-size:11px;color:#9CA3AF">${numLabel}</div>
                <button class="pc-close" data-act="close">✕</button>
            </div>
            <div class="pc-card-body">
                ${pin.comments.length === 0 ? '<div style="padding:12px 0;color:#9CA3AF;font-size:12px;text-align:center">还没有评论，写第一条</div>' : ''}
                ${pin.comments.map(c => `
                    <div class="pc-comment">
                        <div class="pc-comment-meta">
                            <span class="pc-author">${escapeHtml(c.author)}</span>
                            <span>${fmt(c.ts)}</span>
                        </div>
                        <div class="pc-comment-body">${escapeHtml(c.body)}</div>
                    </div>
                `).join('')}
            </div>
            <div class="pc-card-input">
                <textarea rows="2" placeholder="写评论… (⌘/Ctrl + Enter 发送)" maxlength="500"></textarea>
                <div class="pc-actions">
                    <button class="pc-btn pc-btn-danger" data-act="del">删除该 Pin</button>
                    <button class="pc-btn pc-btn-primary" data-act="send" disabled>发送</button>
                </div>
            </div>
        `;

        const ta = card.querySelector('textarea');
        const send = card.querySelector('[data-act="send"]');
        ta.oninput = () => { send.disabled = !ta.value.trim(); };
        ta.onkeydown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doSend(); }
        };
        const doSend = async () => {
            const v = ta.value.trim();
            if (!v) return;
            send.disabled = true;
            try {
                const msg = await insertComment(pin.id, v);
                pin.comments.push(msg);
                renderCard(card, pin);
                if (drawerOpen) renderDrawer();
                const newTa = card.querySelector('textarea');
                if (newTa) newTa.focus();
            } catch (err) {
                console.error('[pin-comments] send comment failed', err);
                showToast('评论发送失败，请稍后重试');
                send.disabled = false;
            }
        };
        send.onclick = doSend;

        card.querySelector('[data-act="close"]').onclick = closeActiveCard;
        card.querySelector('[data-act="del"]').onclick = async () => {
            if (!confirm('确认删除该 Pin 及所有评论？')) return;
            try {
                await deletePin(pin.id);
                pins = pins.filter(p => p.id !== pin.id);
                closeActiveCard();
                refreshAllUi();
            } catch (err) {
                console.error('[pin-comments] delete pin failed', err);
                showToast('删除失败，请稍后重试');
            }
        };
        card.querySelector('[data-act="status"]').onclick = (e) => {
            e.stopPropagation();
            showStatusMenu(card, pin);
        };
    }

    function showStatusMenu(card, pin) {
        const old = card.querySelector('.pc-status-menu');
        if (old) { old.remove(); return; }
        const menu = document.createElement('div');
        menu.className = 'pc-status-menu pc-ui';
        menu.innerHTML = Object.entries(STATUS).map(([k, v]) =>
            `<button data-k="${k}"><span class="dot" style="background:${v.color}"></span>${v.label}</button>`
        ).join('');
        menu.onclick = async (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            const nextStatus = b.dataset.k;
            const prevStatus = pin.status;
            pin.status = nextStatus;
            renderCard(card, pin);
            renderPins();
            if (drawerOpen) renderDrawer();
            try {
                await updatePinStatus(pin.id, nextStatus);
            } catch (err) {
                pin.status = prevStatus;
                renderCard(card, pin);
                renderPins();
                if (drawerOpen) renderDrawer();
                console.error('[pin-comments] update status failed', err);
                showToast('状态同步失败，请稍后重试');
            }
        };
        card.appendChild(menu);
        setTimeout(() => {
            const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', off); } };
            document.addEventListener('click', off);
        }, 0);
    }

    // ============= 抽屉 =============
    function createDrawer() {
        maskEl = document.createElement('div');
        maskEl.className = 'pc-drawer-mask pc-ui';
        maskEl.onclick = () => toggleDrawer(false);
        document.body.appendChild(maskEl);

        drawerEl = document.createElement('div');
        drawerEl.className = 'pc-drawer pc-ui';
        drawerEl.innerHTML = `
            <div class="pc-drawer-head">
                <div class="pc-title">
                    <span class="pc-title-text">评论清单</span>
                    <div class="pc-view-dd" data-role="view-dd">
                        <button class="pc-view-trigger" data-act="view-toggle" type="button">
                            <span class="pc-view-label">全项目</span>
                            <span class="pc-view-meta">0</span>
                            <span class="pc-caret">▾</span>
                        </button>
                        <div class="pc-view-menu" data-role="view-menu"></div>
                    </div>
                    <button class="pc-close-x" data-act="close" type="button" aria-label="关闭">✕</button>
                </div>
                <div class="pc-filters" data-role="filters"></div>
            </div>
            <div class="pc-drawer-body" data-role="list"></div>
            <div class="pc-drawer-foot">
                <div class="pc-nick">当前身份：<b data-role="nick"></b> <a href="#" data-act="rename" style="color:#2563EB;text-decoration:none;margin-left:6px">改</a></div>
                <button class="pc-btn pc-btn-primary" data-act="export">导出 MD</button>
            </div>
        `;
        document.body.appendChild(drawerEl);

        drawerEl.querySelector('[data-act="close"]').onclick = () => toggleDrawer(false);
        drawerEl.querySelector('[data-act="export"]').onclick = exportMarkdown;
        drawerEl.querySelector('[data-act="rename"]').onclick = (e) => {
            e.preventDefault();
            const v = prompt('新名字', getNick());
            if (v && v.trim()) { setNick(v.trim()); renderDrawer(); }
        };

        // 视图 dropdown 切换
        const trigger = drawerEl.querySelector('[data-act="view-toggle"]');
        trigger.onclick = (e) => {
            e.stopPropagation();
            toggleViewMenu();
        };

        renderDrawer();
    }

    // ============= 视图 dropdown =============
    let viewMenuOpen = false;
    function toggleViewMenu(force) {
        const next = typeof force === 'boolean' ? force : !viewMenuOpen;
        if (next === viewMenuOpen) return;
        viewMenuOpen = next;
        const trigger = drawerEl.querySelector('[data-act="view-toggle"]');
        const menu = drawerEl.querySelector('[data-role="view-menu"]');
        if (!trigger || !menu) return;
        trigger.classList.toggle('open', viewMenuOpen);
        menu.classList.toggle('show', viewMenuOpen);
        if (viewMenuOpen) {
            // 延迟绑定外部点击关闭，避免捕获到当前点击事件
            setTimeout(() => document.addEventListener('click', onOutsideViewClick, true), 0);
        } else {
            document.removeEventListener('click', onOutsideViewClick, true);
        }
    }
    function onOutsideViewClick(e) {
        const dd = drawerEl && drawerEl.querySelector('[data-role="view-dd"]');
        if (!dd) return;
        if (!dd.contains(e.target)) toggleViewMenu(false);
    }

    // 当前抽屉视图下应展示的 pin 集合（带本页内编号）
    function viewPins() {
        const local = pagePins();
        const localIdx = new Map(local.map((p, i) => [p.id, i + 1]));
        const source = viewScope === 'page' ? local : pins;
        return source.map(p => ({
            p,
            num: localIdx.has(p.id) ? localIdx.get(p.id) : null // 跨页项无本页编号
        }));
    }

    function renderDrawer() {
        if (!drawerEl) return;
        const local = pagePins();
        const totalAll = pins.length;
        const totalLocal = local.length;
        drawerEl.querySelector('[data-role="nick"]').textContent = getNick() || '未设置';

        // 视图 dropdown：触发器显示当前选中
        const trigger = drawerEl.querySelector('[data-act="view-toggle"]');
        const currentLabel = viewScope === 'page' ? '本页' : '全项目';
        const currentCount = viewScope === 'page' ? totalLocal : totalAll;
        trigger.querySelector('.pc-view-label').textContent = currentLabel;
        trigger.querySelector('.pc-view-meta').textContent = currentCount;

        // 视图 dropdown 菜单：两个选项
        const menu = drawerEl.querySelector('[data-role="view-menu"]');
        const opts = [
            { v: 'page',    label: '本页',   count: totalLocal },
            { v: 'project', label: '全项目', count: totalAll }
        ];
        menu.innerHTML = opts.map(o => `
            <button class="pc-view-option ${viewScope === o.v ? 'active' : ''}" data-v="${o.v}" type="button">
                <span class="pc-vo-check">✓</span>
                <span>${o.label}</span>
                <span class="pc-vo-meta">${o.count}</span>
            </button>
        `).join('');
        menu.querySelectorAll('button').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                toggleViewMenu(false);
                if (viewScope === b.dataset.v) return;
                viewScope = b.dataset.v;
                setView(viewScope);
                renderDrawer();
            };
        });

        // 状态筛选（基于当前视图的范围），count = 0 时隐藏数字、字色变浅
        const scopeSource = viewScope === 'page' ? local : pins;
        const filters = drawerEl.querySelector('[data-role="filters"]');
        const counts = { all: scopeSource.length };
        Object.keys(STATUS).forEach(k => counts[k] = scopeSource.filter(p => p.status === k).length);
        const items = [['all', '全部']].concat(Object.entries(STATUS).map(([k, v]) => [k, v.label]));
        filters.innerHTML = items.map(([k, label]) => {
            const c = counts[k];
            const empty = c === 0 ? ' empty' : '';
            const meta = c > 0 ? `<span class="pc-filter-meta">${c}</span>` : '';
            return `<button class="pc-filter${filterStatus === k ? ' active' : ''}${empty}" data-k="${k}" type="button">${label}${meta}</button>`;
        }).join('');
        filters.querySelectorAll('button').forEach(b => {
            b.onclick = () => { filterStatus = b.dataset.k; renderDrawer(); };
        });

        renderDrawerList();
    }

    function renderDrawerList() {
        const list = drawerEl.querySelector('[data-role="list"]');
        const view = viewPins()
            .filter(({ p }) => filterStatus === 'all' || p.status === filterStatus)
            // 按创建时间倒序（混在一起，不按页分组）
            .sort((a, b) => new Date(b.p.createdAt) - new Date(a.p.createdAt));
        if (!view.length) {
            const tip = viewScope === 'page'
                ? '本页还没有评论。打开评论模式，在页面上点一下试试。'
                : '当前项目下还没有评论。';
            list.innerHTML = `<div class="pc-empty">${tip}</div>`;
            return;
        }
        list.innerHTML = view.map(({ p, num }) => {
            const st = STATUS[p.status];
            const last = p.comments[p.comments.length - 1];
            const preview = last ? last.body : '(空)';
            const author = last ? last.author : p.createdBy;
            const cross = !isCurrentPage(p);
            const numText = num != null ? num : '·';
            const pageBadge = (viewScope === 'project')
                ? `<div class="pc-li-page" title="${escapeHtml(p.pageKey)}">${escapeHtml(p.pageTitle || p.pageKey)}</div>`
                : '';
            return `
                <div class="pc-list-item ${cross ? 'cross-page' : ''}" data-id="${p.id}" data-page="${escapeHtml(p.pageKey)}">
                    <div class="pc-li-head">
                        <div class="pc-li-num">${numText}</div>
                        <div class="pc-li-status" style="background:${st.bg};color:${st.color}">${st.label}</div>
                        ${pageBadge}
                        <div style="margin-left:auto">${p.comments.length} 条</div>
                    </div>
                    <div class="pc-li-body">${escapeHtml(preview)}</div>
                    <div class="pc-li-foot"><span>${escapeHtml(author)}</span><span>${fmt(p.createdAt)}</span></div>
                </div>
            `;
        }).join('');
        list.querySelectorAll('.pc-list-item').forEach(el => {
            el.onclick = () => {
                const id = el.dataset.id;
                jumpToPin(id);
            };
        });
    }

    function jumpToPin(id) {
        const pin = pins.find(p => p.id === id);
        if (!pin) return;
        if (!isCurrentPage(pin)) {
            // 跨页跳转：以当前页面 URL 为 base，让浏览器把 pageKey 当相对路径解析。
            // 这样不管部署在 / 还是 /<repo>/ 子路径下、本地 file:// 还是 http(s)，都能正确算出目标 URL。
            // 老数据 page_key 可能是 "/path/to/page.html" 形式，URL 构造仍能 work，但跨环境部署可能 404，
            // 建议跑 migrate-v0.3-to-v0.4.sql 把 page_key 归一成文件名。
            let target;
            try {
                target = new URL(pin.pageKey, location.href);
            } catch (e) {
                target = null;
            }
            if (target) {
                target.searchParams.set('pc', id);
                location.href = target.href;
            } else {
                const fallback = pin.pageKey + (pin.pageKey.includes('?') ? '&' : '?') + 'pc=' + encodeURIComponent(id);
                location.href = fallback;
            }
            return;
        }
        toggleDrawer(false);
        const el = findEl(pin.selector);
        if (el && !pin.isFixed) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        setTimeout(() => openCard(id), 350);
    }

    function toggleDrawer(open) {
        drawerOpen = open;
        if (open) renderDrawer();
        else if (viewMenuOpen) toggleViewMenu(false);
        maskEl.classList.toggle('show', open);
        drawerEl.classList.toggle('show', open);
    }

    // ============= 导出 MD（按当前视图） =============
    function exportMarkdown() {
        const isProjectView = viewScope === 'project';
        const source = isProjectView ? pins : pagePins();
        const titlePrefix = isProjectView ? `${PROJECT_KEY} · 全项目` : (PAGE_TITLE || PAGE_KEY);
        const lines = [`# ${titlePrefix} 评论清单`, '', `导出时间：${new Date().toLocaleString()}`, `共 ${source.length} 条`, ''];

        // 项目视图按页面分组导出，便于按页 review；本页视图直接列
        if (isProjectView) {
            const byPage = new Map();
            source.forEach(p => {
                const key = p.pageKey;
                if (!byPage.has(key)) byPage.set(key, { title: p.pageTitle || key, items: [] });
                byPage.get(key).items.push(p);
            });
            byPage.forEach((group, key) => {
                lines.push(`## 📄 ${group.title}`);
                lines.push(`- 路径：\`${key}\``);
                lines.push('');
                group.items.forEach((p, i) => writePin(lines, p, i + 1));
            });
        } else {
            source.forEach((p, i) => writePin(lines, p, i + 1));
        }

        const md = lines.join('\n');
        const fname = isProjectView ? `${PROJECT_KEY}-all-comments.md`
            : `${(location.pathname.split('/').pop() || 'page')}-comments.md`;
        navigator.clipboard.writeText(md).then(
            () => showToast('已复制 Markdown 到剪贴板'),
            () => {
                const blob = new Blob([md], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = fname; a.click();
                URL.revokeObjectURL(url);
            }
        );
    }

    function writePin(lines, p, num) {
        const st = STATUS[p.status];
        lines.push(`### #${num} [${st.label}]`);
        lines.push(`- 创建：${p.createdBy} · ${fmt(p.createdAt)}`);
        lines.push(`- 位置：\`${p.selector}\``);
        if (!p.comments.length) {
            lines.push(`- (无评论)`);
        } else {
            p.comments.forEach(c => {
                lines.push(`- **${c.author}** · ${fmt(c.ts)}`);
                c.body.split('\n').forEach(line => lines.push(`  > ${line}`));
            });
        }
        lines.push('');
    }

    // ============= 工具 =============
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // 跨页跳转：URL 带 ?pc=<pinId> 时，落地后自动打开对应 Pin
    function readPendingPinIdFromUrl() {
        try {
            const u = new URL(location.href);
            const id = u.searchParams.get('pc');
            return id ? String(id).trim() : null;
        } catch (e) { return null; }
    }

    function clearPinIdFromUrl() {
        try {
            const u = new URL(location.href);
            if (!u.searchParams.has('pc')) return;
            u.searchParams.delete('pc');
            const next = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash;
            history.replaceState(null, '', next);
        } catch (e) { /* noop */ }
    }

    function jumpToPinAfterLoad(id) {
        const pin = pins.find(p => p.id === id);
        // 数据里没有 / 或 selector 在当前页找不到 → 不报错，悄悄清掉 URL
        if (!pin || !isCurrentPage(pin)) { clearPinIdFromUrl(); return; }
        const el = findEl(pin.selector);
        if (el && !pin.isFixed) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
            openCard(id);
            clearPinIdFromUrl();
        }, 350);
    }

    // ============= 初始化 =============
    function init() {
        injectStyle();
        createPinLayer();
        createFab();
        createDrawer();
        bindTooltipEvents();
        renderPins();
        refreshFab();
        // 加载完成后如果 URL 带 ?pc=<pinId>，等数据回来后自动跳转
        const pendingPinId = readPendingPinIdFromUrl();
        refreshFromCloud(true).then(() => {
            if (pendingPinId) jumpToPinAfterLoad(pendingPinId);
        });
        setupRealtime();

        let raf;
        const reposition = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                renderPins();
                if (activePinId) {
                    const pin = pins.find(p => p.id === activePinId);
                    const pinEl = pinLayer.querySelector(`[data-id="${activePinId}"]`);
                    if (pin && pinEl && activeCard) positionCard(activeCard, pinEl, pin.isFixed);
                }
                if (activeDraft && activeDraft.pinEl && activeDraft.card) {
                    positionCard(activeDraft.card, activeDraft.pinEl, activeDraft.pin.isFixed);
                }
            });
        };
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', () => {
            // 固定定位的 pin 滚动时也要更新
            if (pins.some(p => p.isFixed) || activeCard) reposition();
        }, { passive: true });

        // 点击页面空白处（非 ui、非 pin）关闭卡片
        document.addEventListener('click', (e) => {
            if (isCommentMode) return;
            if (activeCard && !e.target.closest('.pc-ui')) closeActiveCard();
        });

        // 键盘快捷键（Figma 风格）：
        //   C = 进/退评论模式 · V = 退评论模式（Figma 默认指针）
        //   L = 开关评论清单 · H = 切换隐藏 Pin · Esc = 逐层关闭
        // 在 input/textarea/contenteditable / 卡片输入框内全部禁用，避免写评论时误触。
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (viewMenuOpen) { toggleViewMenu(false); return; }
                if (activeCard) { closeActiveCard(); return; }
                if (drawerOpen) { toggleDrawer(false); return; }
                if (isCommentMode) toggleCommentMode();
                return;
            }
            if (isTypingTarget(e.target)) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const k = e.key.toLowerCase();
            if (k === 'c') { e.preventDefault(); toggleCommentMode(); }
            else if (k === 'v') { e.preventDefault(); if (isCommentMode) toggleCommentMode(); }
            else if (k === 'l') { e.preventDefault(); toggleDrawer(!drawerOpen); }
            else if (k === 'h') { e.preventDefault(); togglePinsHidden(); }
        });

        function isTypingTarget(t) {
            if (!t || !t.tagName) return false;
            const tag = t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
            if (t.isContentEditable) return true;
            return false;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
