/* HAE-007 视觉方案原型 —— 纯内存交互演示。
   不读写文件、不解析 HTML、不发起网络请求；仅操作本页内自制报告 DOM。 */
(function () {
  'use strict';

  /* ---------- 固定校稿任务数据（同一份脱敏报告） ---------- */
  var NODES = {
    title:     { label: '报告标题',        original: '2025 年度报告' },
    date:      { label: '副标题日期',      original: '编制日期：2025 年 12 月 31 日' },
    row1note:  { label: '表格：营业收入备注', original: '同比增涨 8.2%' },
    row3label: { label: '表格：第三行指标名', original: '研发投人占比' },
    row4note:  { label: '表格：回款备注',    original: '第四季渡' }
  };
  /* “未保存 / 冲突”演示状态预置的四条已应用变更（日期为可选第五目标，不预置） */
  var PRESET = {
    title: '2026 年度报告',
    row1note: '同比增长 8.2%',
    row3label: '研发投入占比',
    row4note: '第四季度'
  };

  /* ---------- 元素引用 ---------- */
  function $(id) { return document.getElementById(id); }
  var app = $('app'), demoBar = $('demoBar'),
      docFlag = $('docFlag'),
      btnOpen = $('btnOpen'), modeStatic = $('modeStatic'), modeInteractive = $('modeInteractive'),
      btnUndo = $('btnUndo'), btnRedo = $('btnRedo'),
      btnChanges = $('btnChanges'), chgCount = $('chgCount'), btnSave = $('btnSave'),
      btnMore = $('btnMore'), moreMenu = $('moreMenu'),
      modeBanner = $('modeBanner'), readonlyBanner = $('readonlyBanner'), conflictBanner = $('conflictBanner'),
      cfSaveAs = $('cfSaveAs'), cfReload = $('cfReload'), cfCancel = $('cfCancel'),
      dynamicLine = $('dynamicLine'),
      editorEmpty = $('editorEmpty'), editorBody = $('editorBody'), nodeLabel = $('nodeLabel'),
      origText = $('origText'), draftInput = $('draftInput'), pendingBadge = $('pendingBadge'),
      btnApply = $('btnApply'), btnCancel = $('btnCancel'),
      readonlyReason = $('readonlyReason'), modeReason = $('modeReason'),
      changesPanel = $('changesPanel'), changesList = $('changesList'), chgCount2 = $('chgCount2'),
      btnCloseChanges = $('btnCloseChanges'),
      stDoc = $('stDoc'), stRes = $('stRes'), stMode = $('stMode'),
      drawerScrim = $('drawerScrim'), scrim = $('scrim'),
      dialog = $('dialog'), dlgTitle = $('dlgTitle'), dlgBody = $('dlgBody'), dlgActions = $('dlgActions'),
      toast = $('toast'), live = $('live');

  var targetEls = {};
  Array.prototype.forEach.call(document.querySelectorAll('.target'), function (el) {
    targetEls[el.getAttribute('data-node')] = el;
  });

  /* ---------- 状态 ---------- */
  var store = {};
  var composing = false;       // IME 组合中（compositionstart 至 compositionend）
  var toastTimer = null;
  var dlgReturnFocus = null;
  var dlgEscape = null;

  function resetStore(docState) {
    store = {
      scheme: store.scheme || 'a',
      docState: docState,                 // editing | readonly | unsaved | conflict | narrow
      narrowForced: docState === 'narrow',
      autoNarrow: store.autoNarrow || false,
      mode: 'static',                     // static | interactive
      selection: null,
      inputDirty: false,
      ops: [],                            // 已应用的“应用文字”操作组 {nodeId, before, after}
      hi: -1,                             // 撤销指针：ops[0..hi] 生效
      changesOpen: false,
      moreOpen: false,
      conflict: docState === 'conflict'
    };
    if (docState === 'unsaved' || docState === 'conflict') {
      Object.keys(PRESET).forEach(function (id) {
        store.ops.push({ nodeId: id, before: NODES[id].original, after: PRESET[id] });
      });
      store.hi = store.ops.length - 1;
    }
  }

  /* ---------- 派生数据 ---------- */
  function currentText(nodeId) {
    var t = NODES[nodeId].original;
    for (var i = 0; i <= store.hi; i++) {
      if (store.ops[i].nodeId === nodeId) t = store.ops[i].after;
    }
    return t;
  }
  function netChanges() {
    var out = [];
    Object.keys(NODES).forEach(function (id) {
      var cur = currentText(id);
      if (cur !== NODES[id].original) out.push({ nodeId: id, before: NODES[id].original, after: cur });
    });
    return out;
  }
  function isReadonly() { return store.docState === 'readonly'; }
  function isNarrow() { return store.narrowForced || store.autoNarrow; }
  function changesAsDrawer() { return store.scheme === 'a' || isNarrow(); }

  /* ---------- 提示与播报 ---------- */
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2800);
  }
  function announce(msg) { live.textContent = ''; live.textContent = msg; }

  /* ---------- 对话框（有名称、焦点限制、合理回焦；Escape 尊重 IME 组合） ---------- */
  function openDialog(opts) {
    if (!dialog.hidden) { dialog.hidden = true; scrim.hidden = true; }
    else { dlgReturnFocus = document.activeElement; }
    dlgEscape = opts.onEscape || null;
    dlgTitle.textContent = opts.title;
    dlgBody.innerHTML = '';
    if (typeof opts.body === 'string') {
      var p = document.createElement('p'); p.textContent = opts.body; dlgBody.appendChild(p);
    } else if (opts.body) { dlgBody.appendChild(opts.body); }
    dlgActions.innerHTML = '';
    opts.actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (a.kind ? ' ' + a.kind : '');
      b.textContent = a.label;
      b.addEventListener('click', function () {
        if (composing) return;              /* 组合中不响应动作 */
        closeDialog();
        if (a.handler) a.handler();
      });
      dlgActions.appendChild(b);
    });
    scrim.hidden = false;
    dialog.hidden = false;
    var first = dlgActions.querySelector('.primary') || dlgActions.querySelector('button');
    if (first) first.focus();
  }
  function closeDialog() {
    dialog.hidden = true; scrim.hidden = true;
    var back = dlgReturnFocus; dlgReturnFocus = null; dlgEscape = null;
    if (back && document.contains(back)) back.focus();
  }
  dialog.addEventListener('keydown', function (e) {
    if (composing || e.isComposing || e.keyCode === 229) return; /* 输入法优先 */
    if (e.key === 'Tab') { /* 焦点限制在对话框按钮内 */
      var items = dlgActions.querySelectorAll('button');
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      var esc = dlgEscape; closeDialog();
      if (esc) esc();
    }
  });

  /* ---------- 未应用输入保护 ---------- */
  function withInputGuard(next) {
    if (!store.inputDirty || !store.selection) { next(); return; }
    var nodeId = store.selection;
    openDialog({
      title: '有未应用的输入',
      body: '“' + NODES[nodeId].label + '”的输入尚未应用。继续前请选择处理方式。',
      onEscape: function () { draftInput.focus(); },
      actions: [
        { label: '应用后继续', kind: 'primary', handler: function () { applyInput(); next(); } },
        { label: '放弃输入', handler: function () { discardInput(); next(); } },
        { label: '继续编辑', handler: function () { draftInput.focus(); } }
      ]
    });
  }

  /* ---------- 选择与编辑 ---------- */
  function selectNode(nodeId, focusInput) {
    if (composing) return;
    if (isReadonly()) { showToast('只读状态：' + NODES[nodeId].label + '不可编辑'); return; }
    if (store.mode === 'interactive') { showToast('交互预览为只读，切回静态校稿后编辑'); return; }
    if (nodeId === store.selection) {
      /* 同一目标：保留未应用输入，不弹保护、不清空；双击仅聚焦输入框 */
      if (focusInput) {
        draftInput.focus();
        draftInput.setSelectionRange(draftInput.value.length, draftInput.value.length);
      }
      return;
    }
    withInputGuard(function () {
      store.selection = nodeId;
      store.inputDirty = false;
      render();
      if (focusInput) {
        draftInput.focus();
        draftInput.setSelectionRange(draftInput.value.length, draftInput.value.length);
      } else if (targetEls[nodeId]) {
        targetEls[nodeId].focus();
      }
      announce('已选中：' + NODES[nodeId].label);
    });
  }
  function clearSelection() {
    store.selection = null;
    store.inputDirty = false;
    render();
  }
  function applyInput() {
    if (composing) return;
    var id = store.selection;
    if (!id || isReadonly() || store.mode === 'interactive') return;
    var v = draftInput.value, cur = currentText(id);
    if (v === cur) {
      store.inputDirty = false;
      showToast('内容无变化，未新增变更');
      render();
      return;
    }
    store.ops = store.ops.slice(0, store.hi + 1);
    store.ops.push({ nodeId: id, before: cur, after: v });
    store.hi = store.ops.length - 1;
    store.inputDirty = false;
    if (v === NODES[id].original) announce('已恢复原文，净变更移除：' + NODES[id].label);
    else announce('已应用：' + NODES[id].label);
    render();
  }
  function discardInput() {
    if (!store.selection) return;
    draftInput.value = currentText(store.selection);
    store.inputDirty = false;
    render();
  }
  function cancelInput() {
    if (composing) return;
    if (!store.selection) return;
    discardInput();
    announce('已取消未应用输入');
  }

  /* 历史操作：有未应用输入时先保护；无输入时输入框同步到新的当前草稿 */
  function doUndo() {
    if (store.hi < 0) { showToast('没有可撤销的操作'); return; }
    store.hi--;
    announce('已撤销');
    render();
  }
  function doRedo() {
    if (store.hi >= store.ops.length - 1) { showToast('没有可重做的操作'); return; }
    store.hi++;
    announce('已重做');
    render();
  }
  function requestUndo() {
    if (composing) return;
    withInputGuard(doUndo);
  }
  function requestRedo() {
    if (composing) return;
    withInputGuard(doRedo);
  }
  function revertChange(nodeId) {
    if (composing) return;
    if (isReadonly()) return;
    withInputGuard(function () {
      /* 删除一条变更 = 撤销该条草稿（生成一个可再撤销的反向操作组） */
      var cur = currentText(nodeId);
      if (cur === NODES[nodeId].original) return;
      store.ops = store.ops.slice(0, store.hi + 1);
      store.ops.push({ nodeId: nodeId, before: cur, after: NODES[nodeId].original });
      store.hi = store.ops.length - 1;
      announce('已撤销该条草稿：' + NODES[nodeId].label);
      render();
    });
  }
  function locateChange(nodeId) {
    var el = targetEls[nodeId];
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  /* ---------- 模式切换（保护输入与草稿） ---------- */
  function setMode(mode) {
    if (composing) return;
    if (mode === store.mode) return;
    withInputGuard(function () {
      store.mode = mode;   /* 草稿（ops）与选择保留，仅关闭/恢复编辑入口 */
      announce(mode === 'interactive' ? '已切换到交互预览（只读）' : '已切换到静态校稿');
      render();
    });
  }

  /* ---------- 演示动作（明确标注，不读写文件） ---------- */
  function demoOpen() {
    if (composing) return;
    withInputGuard(function () {
      openDialog({
        title: '打开（演示）',
        body: '演示：真实产品将在此打开系统文件选择器并校验编码与资源。本原型不访问文件系统。',
        actions: [{ label: '知道了', kind: 'primary' }]
      });
    });
  }
  function demoSaveFlow() {
    if (composing) return;
    if (isReadonly()) { showToast('只读状态不能保存'); return; }
    var showSaveDemo = function () {
      openDialog({
        title: '保存（演示）',
        body: '演示：真实产品将在此执行冲突检查、备份与写入事务，回读校验成功后才显示“已保存”。本原型不访问文件，也不改变任何状态。',
        actions: [{ label: '知道了', kind: 'primary' }]
      });
    };
    if (store.inputDirty && store.selection) {
      openDialog({
        title: '保存前有未应用的输入',
        body: '“' + NODES[store.selection].label + '”的输入尚未应用，请选择如何处理。',
        onEscape: function () { draftInput.focus(); },
        actions: [
          { label: '应用并保存', kind: 'primary', handler: function () { applyInput(); showSaveDemo(); } },
          { label: '放弃输入并保存', handler: function () { discardInput(); showSaveDemo(); } },
          { label: '取消', handler: function () { draftInput.focus(); } }
        ]
      });
    } else {
      showSaveDemo();
    }
  }
  function demoSaveAs() {
    if (composing) return;
    openDialog({
      title: '另存为（演示）',
      body: '演示：另存为不会覆盖原文件。本原型不发起下载、不访问文件。',
      actions: [{ label: '知道了', kind: 'primary' }]
    });
  }
  function demoResources() {
    var box = document.createElement('div');
    var p = document.createElement('p');
    p.textContent = '离线策略默认阻断外部请求，页面效果可能不完整；本原型不会联网。';
    var ul = document.createElement('ul');
    ['https://cdn.example.invalid/chart.min.js（脚本）', 'https://fonts.example.invalid/report.woff2（字体）']
      .forEach(function (s) { var li = document.createElement('li'); li.textContent = s; ul.appendChild(li); });
    box.appendChild(p); box.appendChild(ul);
    openDialog({
      title: '资源状态（演示）',
      body: box,
      actions: [{ label: '知道了', kind: 'primary' }]
    });
  }

  /* ---------- 冲突 ---------- */
  function conflictSaveAs() {
    if (composing) return;
    showToast('演示：另存草稿不会写盘，也未包含其他程序的修改');
  }
  function conflictReload() {
    if (composing) return;
    var n = netChanges().length;
    var box = document.createElement('div');
    var p = document.createElement('p');
    p.textContent = n > 0
      ? '重新加载将放弃 ' + n + ' 条未保存的变更，且不可恢复。是否继续？'
      : '将放弃当前会话并重新从磁盘加载（演示，不实际读盘）。是否继续？';
    box.appendChild(p);
    openDialog({
      title: '重新加载前确认',
      body: box,
      actions: [
        { label: '放弃变更并重新加载（演示）', kind: 'primary', handler: function () {
          setDocState('editing');
          showToast('演示：已模拟重新加载，草稿已放弃（未读盘）');
        } },
        { label: '取消', handler: function () {} }
      ]
    });
  }
  function conflictCancel() {
    if (composing) return;
    showToast('已取消：保留草稿与冲突提示，未覆盖文件');
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var narrow = isNarrow();
    var drawer = changesAsDrawer();
    app.className = 'scheme-' + store.scheme
      + (store.mode === 'interactive' ? ' mode-interactive' : ' mode-static')
      + (isReadonly() ? ' is-readonly' : '')
      + (narrow ? ' is-narrow' : '')
      + (drawer ? ' changes-drawer' : '')
      + (drawer && store.changesOpen ? ' changes-open' : '');

    /* 演示控制器按钮态 */
    Array.prototype.forEach.call(demoBar.querySelectorAll('[data-scheme]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-scheme') === store.scheme));
    });
    Array.prototype.forEach.call(demoBar.querySelectorAll('[data-state]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-state') === store.docState));
    });

    /* 预览目标文字与状态 */
    Object.keys(NODES).forEach(function (id) {
      var el = targetEls[id];
      el.textContent = currentText(id);
      el.classList.toggle('is-selected', store.selection === id);
      el.classList.toggle('is-changed', currentText(id) !== NODES[id].original);
      el.classList.toggle('has-pending', store.selection === id && store.inputDirty);
      var editable = !isReadonly() && store.mode === 'static';
      el.setAttribute('tabindex', editable ? '0' : '-1');
      el.setAttribute('aria-label', (editable ? '可编辑文字：' : '只读文字：') + NODES[id].label);
    });
    dynamicLine.hidden = store.mode !== 'interactive';

    /* 横幅 */
    modeBanner.hidden = store.mode !== 'interactive';
    readonlyBanner.hidden = !isReadonly();
    conflictBanner.hidden = !store.conflict;

    /* 工具栏 */
    var changes = netChanges();
    docFlag.hidden = changes.length === 0;
    chgCount.textContent = String(changes.length);
    chgCount.classList.toggle('has', changes.length > 0);
    chgCount2.textContent = String(changes.length);
    chgCount2.classList.toggle('has', changes.length > 0);
    btnChanges.setAttribute('aria-expanded', String(drawer && store.changesOpen));
    btnUndo.disabled = store.hi < 0;
    btnRedo.disabled = store.hi >= store.ops.length - 1;
    btnSave.disabled = isReadonly();
    modeStatic.setAttribute('aria-pressed', String(store.mode === 'static'));
    modeInteractive.setAttribute('aria-pressed', String(store.mode === 'interactive'));

    /* 校稿栏：文件原文、已应用草稿、尚未应用输入三者分开 */
    var editingEnabled = !isReadonly() && store.mode === 'static';
    readonlyReason.hidden = !isReadonly();
    modeReason.hidden = !(store.mode === 'interactive' && !isReadonly());
    if (store.selection) {
      editorEmpty.hidden = true;
      editorBody.hidden = false;
      nodeLabel.textContent = NODES[store.selection].label;
      origText.textContent = NODES[store.selection].original;   /* 始终是文件原文 */
      if (!store.inputDirty && draftInput.value !== currentText(store.selection)) {
        draftInput.value = currentText(store.selection);        /* 输入框显示已应用草稿 */
      }
      draftInput.disabled = !editingEnabled;
      btnApply.disabled = !editingEnabled;
      btnCancel.disabled = !editingEnabled || !store.inputDirty;
      pendingBadge.hidden = !store.inputDirty;
    } else {
      /* 无选中目标：仅在可编辑的静态校稿状态显示选字邀请；
         文件只读或交互预览时隐藏邀请，保留对应只读原因 */
      editorEmpty.hidden = !editingEnabled;
      editorBody.hidden = true;
      nodeLabel.textContent = '';
    }

    /* 变更列表 */
    changesList.innerHTML = '';
    if (!changes.length) {
      var empty = document.createElement('div');
      empty.className = 'changes-empty';
      empty.textContent = '尚无变更。选择文字、输入并应用后，在此查看改前改后。';
      changesList.appendChild(empty);
    } else {
      changes.forEach(function (c) {
        var item = document.createElement('div');
        item.className = 'change-item';
        var head = document.createElement('div');
        head.className = 'ci-head';
        var name = document.createElement('span');
        name.textContent = NODES[c.nodeId].label;
        var acts = document.createElement('span');
        acts.className = 'ci-actions';
        var bLocate = document.createElement('button');
        bLocate.type = 'button'; bLocate.className = 'btn'; bLocate.textContent = '定位';
        bLocate.addEventListener('click', function () { locateChange(c.nodeId); });
        var bRevert = document.createElement('button');
        bRevert.type = 'button'; bRevert.className = 'btn'; bRevert.textContent = '撤销此条';
        bRevert.disabled = isReadonly();
        bRevert.addEventListener('click', function () { revertChange(c.nodeId); });
        acts.appendChild(bLocate); acts.appendChild(bRevert);
        head.appendChild(name); head.appendChild(acts);
        var diff = document.createElement('div');
        diff.className = 'ci-diff';
        var oldLine = document.createElement('span');
        oldLine.className = 'ci-old'; oldLine.textContent = c.before;
        var newLine = document.createElement('span');
        newLine.className = 'ci-new'; newLine.textContent = c.after;
        diff.appendChild(oldLine); diff.appendChild(newLine);
        item.appendChild(head); item.appendChild(diff);
        changesList.appendChild(item);
      });
    }

    /* 变更抽屉的可交互性：关闭时真正不可聚焦，打开时有名称与焦点范围 */
    if (drawer) {
      changesPanel.setAttribute('role', 'dialog');
      changesPanel.setAttribute('aria-label', '变更复核');
      if (store.changesOpen) {
        changesPanel.inert = false;
        changesPanel.removeAttribute('aria-hidden');
        var active = document.activeElement;
        if (!changesPanel.contains(active)) btnCloseChanges.focus();
      } else {
        if (changesPanel.contains(document.activeElement)) btnChanges.focus();
        changesPanel.inert = true;
        changesPanel.setAttribute('aria-hidden', 'true');
      }
    } else {
      changesPanel.removeAttribute('role');
      changesPanel.inert = false;
      changesPanel.removeAttribute('aria-hidden');
    }

    /* 状态栏 */
    stDoc.className = 'st-item';
    if (store.conflict) { stDoc.textContent = '冲突：文件已被其他程序修改，本次尚未覆盖'; stDoc.classList.add('danger'); }
    else if (isReadonly()) { stDoc.textContent = '只读'; stDoc.classList.add('warn'); }
    else if (changes.length) { stDoc.textContent = '有 ' + changes.length + ' 条未保存变更'; stDoc.classList.add('warn'); }
    else { stDoc.textContent = '就绪'; }
    stMode.textContent = store.mode === 'interactive' ? '交互预览（只读）' : '静态校稿';

    drawerScrim.hidden = !(drawer && store.changesOpen);
  }

  /* ---------- 变更抽屉 / 更多菜单 ---------- */
  function openChangesDrawer() {
    store.changesOpen = true;
    render();   /* render 会把焦点移入抽屉（关闭按钮） */
  }
  function closeChangesDrawer(refocus) {
    store.changesOpen = false;
    render();
    if (refocus) btnChanges.focus();
  }
  function toggleChanges() {
    if (composing) return;
    if (changesAsDrawer()) {
      if (store.changesOpen) closeChangesDrawer(true);
      else openChangesDrawer();
    } else {
      changesPanel.scrollIntoView({ block: 'nearest' });
      var head = changesPanel.querySelector('.panel-head');
      head.classList.remove('flash');
      void head.offsetWidth;
      head.classList.add('flash');
    }
  }
  /* 抽屉打开时 Tab 焦点限制在面板内 */
  changesPanel.addEventListener('keydown', function (e) {
    if (!changesAsDrawer() || !store.changesOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      closeChangesDrawer(true);
      return;
    }
    if (e.key === 'Tab') {
      var items = changesPanel.querySelectorAll('button:not(:disabled)');
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  function closeMore(refocus) {
    store.moreOpen = false;
    moreMenu.hidden = true;
    btnMore.setAttribute('aria-expanded', 'false');
    if (refocus) btnMore.focus();
  }
  function toggleMore() {
    store.moreOpen = !store.moreOpen;
    moreMenu.hidden = !store.moreOpen;
    btnMore.setAttribute('aria-expanded', String(store.moreOpen));
    if (store.moreOpen) moreMenu.querySelector('button').focus();
  }

  /* ---------- 方案与演示状态切换 ---------- */
  function setScheme(s) {
    store.scheme = s;
    store.changesOpen = false;
    render();
    syncURL();
  }
  function setDocState(s) {
    var scheme = store.scheme, auto = store.autoNarrow;
    resetStore(s);
    store.scheme = scheme;
    store.autoNarrow = auto;
    render();
    syncURL();
  }
  function syncURL() {
    try {
      var q = '?scheme=' + store.scheme + '&state=' + store.docState
        + (store.narrowForced ? '&width=narrow' : '');
      history.replaceState(null, '', q);
    } catch (e) { /* file:// 下忽略 */ }
  }

  /* ---------- 事件绑定 ---------- */
  demoBar.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-scheme')) setScheme(b.getAttribute('data-scheme'));
    else if (b.hasAttribute('data-state')) setDocState(b.getAttribute('data-state'));
  });

  Object.keys(targetEls).forEach(function (id) {
    var el = targetEls[id];
    el.addEventListener('click', function () { selectNode(id, false); });
    el.addEventListener('dblclick', function () { selectNode(id, true); });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !composing && !e.isComposing) {
        e.preventDefault();
        selectNode(id, true);
      }
    });
  });

  draftInput.addEventListener('input', function () {
    store.inputDirty = store.selection ? (draftInput.value !== currentText(store.selection)) : false;
    pendingBadge.hidden = !store.inputDirty;
    if (store.selection) targetEls[store.selection].classList.toggle('has-pending', store.inputDirty);
    btnCancel.disabled = !store.inputDirty;
  });
  /* 粘贴使用 textarea 原生行为：本身就是纯文本，且保留浏览器输入撤销；
     不拦截、不使用 contenteditable、不接受 HTML。 */

  /* IME 组合跟踪：捕获阶段监听，覆盖输入框及任何后续输入控件 */
  document.addEventListener('compositionstart', function () { composing = true; }, true);
  document.addEventListener('compositionend', function () { composing = false; }, true);

  btnApply.addEventListener('click', applyInput);
  btnCancel.addEventListener('click', cancelInput);
  btnUndo.addEventListener('click', requestUndo);
  btnRedo.addEventListener('click', requestRedo);
  btnSave.addEventListener('click', demoSaveFlow);
  btnOpen.addEventListener('click', demoOpen);
  btnChanges.addEventListener('click', toggleChanges);
  btnCloseChanges.addEventListener('click', function () { closeChangesDrawer(true); });
  drawerScrim.addEventListener('click', function () { closeChangesDrawer(true); });
  modeStatic.addEventListener('click', function () { setMode('static'); });
  modeInteractive.addEventListener('click', function () { setMode('interactive'); });
  stRes.addEventListener('click', demoResources);
  cfSaveAs.addEventListener('click', conflictSaveAs);
  cfReload.addEventListener('click', conflictReload);
  cfCancel.addEventListener('click', conflictCancel);
  btnMore.addEventListener('click', toggleMore);
  $('menuOpen').addEventListener('click', function () { closeMore(false); demoOpen(); });
  $('menuModeStatic').addEventListener('click', function () { closeMore(false); setMode('static'); });
  $('menuModeInteractive').addEventListener('click', function () { closeMore(false); setMode('interactive'); });
  $('menuSaveAs').addEventListener('click', function () { closeMore(false); demoSaveAs(); });
  document.addEventListener('click', function (e) {
    if (store.moreOpen && !e.target.closest('#moreMenu') && !e.target.closest('#btnMore')) closeMore(false);
  });

  /* ---------- 键盘：IME 期间不响应应用级快捷键；输入框内 Ctrl+Z 交给浏览器 ---------- */
  document.addEventListener('keydown', function (e) {
    if (composing || e.isComposing || e.keyCode === 229) return; /* 输入法优先，不重放指令 */
    if (!dialog.hidden) return; /* 对话框自行处理 Escape/Tab */
    var inText = e.target && e.target.closest && e.target.closest('textarea, input');

    if (e.key === 'Escape') {
      if (store.moreOpen) { closeMore(true); return; }
      if (inText) {
        if (store.inputDirty) { e.preventDefault(); cancelInput(); }
        return;
      }
      if (store.changesOpen && changesAsDrawer()) { closeChangesDrawer(true); return; }
      if (store.selection) clearSelection();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    var k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      if (e.shiftKey) demoSaveAs(); else demoSaveFlow();
      return;
    }
    if (k === 'o') { e.preventDefault(); demoOpen(); return; }
    if (k === 'enter' && inText === draftInput) { e.preventDefault(); applyInput(); return; }
    if (inText) return; /* 输入框内 Ctrl+Z 等交给浏览器本地输入撤销 */
    if (k === 'z') { e.preventDefault(); if (e.shiftKey) requestRedo(); else requestUndo(); return; }
    if (k === 'y') { e.preventDefault(); requestRedo(); return; }
  });

  /* ---------- 实际窗口宽度响应：最小候选尺寸 960×640 已进入窄布局 ---------- */
  var mq = window.matchMedia('(max-width: 1023px)');
  function onMQ() {
    store.autoNarrow = mq.matches;
    render();
  }
  if (mq.addEventListener) mq.addEventListener('change', onMQ);
  else if (mq.addListener) mq.addListener(onMQ);

  /* ---------- 初始化：读取 URL 参数 ---------- */
  function init() {
    var params = new URLSearchParams(location.search);
    var scheme = (params.get('scheme') || 'a').toLowerCase();
    var state = (params.get('state') || 'editing').toLowerCase();
    var width = (params.get('width') || '').toLowerCase();
    if (['a', 'b', 'c'].indexOf(scheme) < 0) scheme = 'a';
    if (['editing', 'readonly', 'unsaved', 'conflict', 'narrow'].indexOf(state) < 0) state = 'editing';
    resetStore(state);
    store.scheme = scheme;
    store.autoNarrow = mq.matches;
    if (width === 'narrow') store.narrowForced = true;
    render();
  }
  init();
})();
