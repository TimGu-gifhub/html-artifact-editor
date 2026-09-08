async (page) => {
  const passed = [];
  const failures = [];
  const requests = [];
  const pageErrors = [];
  const requestListener = request => requests.push(request.url());
  const errorListener = error => pageErrors.push(String(error));
  page.on('request', requestListener);
  page.on('pageerror', errorListener);
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const value = () => page.locator('#draftInput').inputValue();
  const count = () => page.locator('#chgCount').innerText();
  const title = () => page.locator('[data-node=title]').innerText();
  const dialogVisible = () => page.locator('#dialog').isVisible();
  const pending = () => page.locator('#pendingBadge').isVisible();
  const focusId = () => page.evaluate(() => document.activeElement.id);
  const action = name => page.locator('#dlgActions').getByRole('button', { name, exact: true }).click();
  const load = async (scheme = 'a', state = 'editing', width = 1440, height = 900) => {
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:5177/?scheme=${scheme}&state=${state}`);
  };
  const selectTitle = () => page.locator('[data-node=title]').click();
  const fill = text => page.locator('#draftInput').fill(text);
  const apply = () => page.locator('#btnApply').click();
  const group = async (name, test) => {
    try { await test(); passed.push(name); }
    catch (error) { failures.push({ name, error: String(error) }); }
  };
  try {
    await group('Three layouts: clean, readonly, unsaved and conflict states', async () => {
      for (const scheme of ['a', 'b', 'c']) {
        for (const state of ['editing', 'readonly', 'unsaved', 'conflict']) {
          await load(scheme, state);
          check(await page.locator('#readonlyBanner').isVisible() === (state === 'readonly'), `${scheme}/${state}: readonly banner`);
          check(await page.locator('#conflictBanner').isVisible() === (state === 'conflict'), `${scheme}/${state}: conflict banner`);
          check(!await page.locator('#modeBanner').isVisible(), `${scheme}/${state}: interactive banner hidden`);
          check(await count() === (['unsaved', 'conflict'].includes(state) ? '4' : '0'), `${scheme}/${state}: count`);
          check(!await page.locator('#btnMore').isVisible(), `${scheme}/${state}: wide menu hidden`);
          if (state === 'readonly') {
            check(await page.locator('#btnSave').isDisabled(), 'readonly save disabled');
            check(!await page.locator('#draftInput').isVisible(), 'readonly input closed');
          } else {
            await selectTitle();
            check(await page.locator('#origText').innerText() === '2025 年度报告', 'file baseline distinct from draft');
            await page.screenshot({ path: `output/playwright/hae007-${scheme}-${state}.png` });
          }
        }
      }
    });
    await group('Readonly and interactive empty states show reasons without an editing invitation', async () => {
      for (const scheme of ['a', 'b', 'c']) {
        await load(scheme, 'readonly');
        check(!await page.locator('#editorEmpty').isVisible() && await page.locator('#readonlyReason').isVisible(), `${scheme}: readonly reason only`);
        await page.screenshot({ path: `output/playwright/hae007-${scheme}-readonly.png` });
        await load(scheme, 'editing');
        check(await page.locator('#editorEmpty').isVisible(), `${scheme}: static editing invitation`);
        await page.locator('#modeInteractive').click();
        check(!await page.locator('#editorEmpty').isVisible() && await page.locator('#modeReason').isVisible(), `${scheme}: interactive reason only`);
        await page.locator('#modeStatic').click();
        check(await page.locator('#editorEmpty').isVisible(), `${scheme}: return restores invitation`);
      }
    });
    await group('Unapplied input survives blur and same-target clicks; Escape cancels without history', async () => {
      await load(); await selectTitle(); await fill('2026 年度报告');
      await page.locator('#docName').click();
      check(await pending() && await value() === '2026 年度报告', 'blur keeps input');
      check(await title() === '2025 年度报告' && await count() === '0', 'blur does not apply');
      await selectTitle();
      check(!await dialogVisible() && await value() === '2026 年度报告', 'same target preserves input');
      await page.locator('[data-node=title]').dblclick();
      check(await focusId() === 'draftInput' && !await dialogVisible(), 'double click focuses input');
      await page.keyboard.press('Escape');
      check(await value() === '2025 年度报告' && !await pending(), 'Escape cancels input');
      check(await count() === '0' && await page.locator('#btnUndo').isDisabled(), 'cancel has no history');
    });
    await group('Apply/undo/redo sync input; pending input protects history; no-op has no history', async () => {
      await load(); await selectTitle(); await fill('2026 年度报告');
      await page.locator('#draftInput').press('Control+Enter');
      check(await count() === '1' && !await pending(), 'apply');
      await page.locator('#btnUndo').click();
      check(await title() === '2025 年度报告' && await value() === '2025 年度报告' && !await pending(), 'undo synchronizes input');
      await page.locator('#btnRedo').click();
      check(await value() === '2026 年度报告' && !await pending(), 'redo synchronizes input');
      await fill('2027 年度报告'); await page.locator('#btnUndo').click();
      check(await dialogVisible(), 'history guarded');
      await action('继续编辑');
      check(await value() === '2027 年度报告' && await pending() && await count() === '1', 'continue keeps input');
      await page.locator('#btnUndo').click(); await action('放弃输入');
      check(await value() === '2025 年度报告' && !await pending() && await count() === '0', 'discard then undo');
      await page.locator('#btnRedo').click();
      await apply(); // Same current value must not create a second history operation.
      await page.locator('#btnUndo').click();
      check(await count() === '0', 'no-op does not add history');
    });
    await group('Four corrections, canceled fifth input, drawer focus and return paths', async () => {
      await load();
      const edits = { title: '2026 年度报告', row1note: '同比增长 8.2%', row3label: '研发投入占比', row4note: '第四季度' };
      for (const [id, text] of Object.entries(edits)) {
        await page.locator(`[data-node=${id}]`).click(); await fill(text); await apply();
      }
      check(await count() === '4', 'four net edits');
      await page.locator('[data-node=date]').click(); await fill('取消此输入');
      await page.locator('#draftInput').press('Escape');
      check(await count() === '4' && !await pending(), 'canceled fifth input');
      check(await page.locator('#changesPanel').evaluate(el => el.inert), 'closed drawer inert');
      await page.locator('#btnChanges').click();
      check(await focusId() === 'btnCloseChanges', 'drawer initial focus');
      check(await page.locator('#changesList .change-item').count() === 4, 'four changes listed');
      await page.keyboard.press('Shift+Tab');
      check(await page.locator('#changesPanel button').last().evaluate(el => el === document.activeElement), 'drawer reverse wrap');
      await page.keyboard.press('Tab');
      check(await focusId() === 'btnCloseChanges', 'drawer forward wrap');
      await page.keyboard.press('Escape');
      check(await focusId() === 'btnChanges' && await page.locator('#changesPanel').evaluate(el => el.inert), 'Escape closes and returns focus');
      await page.locator('#btnChanges').click(); await page.locator('#btnCloseChanges').click();
      check(await focusId() === 'btnChanges', 'close button returns focus');
      await page.locator('#btnChanges').click(); await page.locator('#drawerScrim').click({ position: { x: 20, y: 100 } });
      check(await focusId() === 'btnChanges', 'scrim returns focus');
    });
    await group('Mode switch protects pending input and retains applied drafts', async () => {
      await load('b', 'unsaved'); await selectTitle(); await fill('2030 年度报告');
      await page.locator('#modeInteractive').click();
      check(await dialogVisible(), 'mode guarded'); await action('继续编辑');
      check(await value() === '2030 年度报告' && await pending(), 'continue edit after mode guard');
      await page.locator('#modeInteractive').click(); await action('应用后继续');
      check(await page.locator('#modeBanner').isVisible() && await page.locator('#draftInput').isDisabled(), 'interactive editing disabled');
      check(await count() === '4', 'interactive retains drafts');
      await page.locator('#modeStatic').click();
      check(await value() === '2030 年度报告' && !await pending() && await count() === '4', 'return to static restores draft');
      check(await page.locator('#origText').innerText() === '2025 年度报告', 'file baseline unchanged');
    });
    await group('Synthetic composition guards buttons, target changes and shortcuts; no replay', async () => {
      await load(); await selectTitle(); await fill('2026 年度报告');
      await page.locator('#draftInput').dispatchEvent('compositionstart');
      for (const selector of ['#btnApply', '#btnCancel', '#modeInteractive', '[data-node=date]', '#btnOpen', '#btnSave']) await page.locator(selector).click();
      for (const init of [{ key: 'Enter', ctrlKey: true }, { key: 's', ctrlKey: true }, { key: 'Escape' }]) {
        await page.locator('#draftInput').dispatchEvent('keydown', { ...init, bubbles: true, isComposing: true });
      }
      check(await count() === '0' && await value() === '2026 年度报告' && await pending(), 'composition preserves input');
      check(await page.locator('#nodeLabel').innerText() === '报告标题' && !await dialogVisible(), 'composition does not switch or open dialog');
      check(!await page.locator('#modeBanner').isVisible(), 'composition mode unchanged');
      await page.locator('#draftInput').dispatchEvent('compositionend');
      check(await count() === '0' && !await dialogVisible(), 'no replay after composition');
      await apply(); check(await count() === '1', 'fresh action after composition applies');
    });
    await group('Native input undo and literal markup text stay separate from application history', async () => {
      await load(); await selectTitle();
      await page.locator('#draftInput').focus(); await page.keyboard.press('End');
      await page.keyboard.type('X'); await page.keyboard.press('Control+z');
      check(await value() === '2025 年度报告' && await count() === '0', 'native input undo');
      const literal = '<script>alert(1)</script> & 中文 🧪';
      await fill(literal); await apply();
      check(await title() === literal, 'markup shown as literal text');
      check(await page.locator('[data-node=title] > *').count() === 0, 'no injected element');
      await fill('2025 年度报告'); await apply();
      check(await count() === '0', 'return to original removes net edit');
    });
    await group('Conflict cancel/reload confirmation and save remain honest simulations', async () => {
      await load('c', 'conflict');
      await page.locator('#cfReload').click();
      check(await page.locator('#dlgTitle').innerText() === '重新加载前确认', 'reload requires confirmation');
      await action('取消');
      check(await count() === '4' && await page.locator('#conflictBanner').isVisible(), 'cancel keeps conflict drafts');
      await page.locator('#cfCancel').click(); check(await count() === '4', 'cancel does not clear drafts');
      await load('b', 'unsaved'); await page.locator('#btnSave').click();
      check(await page.locator('#dlgTitle').innerText() === '保存（演示）', 'save explicitly demo');
      check(await count() === '4' && (await page.locator('#stDoc').innerText()).includes('未保存'), 'demo does not claim saved');
      await page.keyboard.press('Tab'); check(await page.locator('#dialog').evaluate(el => el.contains(document.activeElement)), 'dialog focus wraps');
      await page.keyboard.press('Escape'); check(await focusId() === 'btnSave', 'dialog returns focus');
    });
    await group('All layouts usable at 960x640 with changes drawer and reachable controls', async () => {
      for (const scheme of ['a', 'b', 'c']) {
        await load(scheme, 'unsaved', 960, 640); await selectTitle();
        check(await page.locator('#app').evaluate(el => el.classList.contains('is-narrow')), `${scheme}: narrow layout`);
        check(await page.locator('#changesPanel').evaluate(el => el.inert), `${scheme}: changes use drawer`);
        check(!await page.locator('#modeStatic').isVisible() && await page.locator('#btnMore').isVisible(), `${scheme}: secondary controls collapsed`);
        // A translated, hidden/inert drawer contributes to scrollWidth even though
        // body overflow is clipped. Check the visible editor regions themselves.
        check(await page.evaluate(() => ['app', 'preview', 'editorPanel'].every(id => {
          const rect = document.getElementById(id).getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth;
        }) && getComputedStyle(document.body).overflowX === 'hidden'), `${scheme}: visible editor fits viewport`);
        const preview = await page.locator('#preview').boundingBox();
        check(preview && preview.height >= 100, `${scheme}: preview remains usable`);
        await page.locator('#draftInput').scrollIntoViewIfNeeded(); await fill('2031 年度报告');
        await apply(); check(await title() === '2031 年度报告', `${scheme}: apply reachable`);
        await page.locator('#btnMore').click(); await page.keyboard.press('Escape');
        check(await focusId() === 'btnMore' && !await page.locator('#moreMenu').isVisible(), `${scheme}: menu return focus`);
        await page.screenshot({ path: `output/playwright/hae007-${scheme}-narrow.png` });
      }
    });
    await group('No runtime errors or external resource requests', async () => {
      check(pageErrors.length === 0, JSON.stringify(pageErrors));
      check(requests.every(url => url.startsWith('http://127.0.0.1:5177/')), 'unexpected external request');
    });
    return { status: failures.length ? 'failed' : 'passed', passed, failures, pageErrors,
      viewport: [1440, 900, 960, 640], userAgent: await page.evaluate(() => navigator.userAgent),
      requestCount: requests.length,
      pending: ['real Windows IME and clipboard paste', 'screen readers', 'system DPI', 'product UI and real file transactions'] };
  } finally { page.off('request', requestListener); page.off('pageerror', errorListener); }
}
