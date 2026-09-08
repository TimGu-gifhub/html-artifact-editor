async (page) => {
  const requests = [];
  const errors = [];
  const onRequest = (request) => requests.push(request.url());
  const onError = (error) => errors.push(String(error));
  page.on('request', onRequest); page.on('pageerror', onError);
  try {
    await page.goto('http://127.0.0.1:5180/%E5%8F%A6%E5%AD%98%E6%8A%A5%E5%91%8A.html');
    const actual = await page.evaluate(() => ({
      heading: document.querySelector('h1').textContent,
      cells: [...document.querySelectorAll('td')].map((cell) => cell.textContent),
      pre: document.querySelector('pre').textContent,
      color: getComputedStyle(document.querySelector('h1')).color,
      scripts: document.scripts.length, originalScript: window.originalScript,
      userAgent: navigator.userAgent,
    }));
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    check(actual.heading === '报告 2026', 'heading mismatch');
    check(JSON.stringify(actual.cells) === JSON.stringify(['相同文字', '第二个单元格，增长 & 😀']), 'table mismatch');
    check(actual.pre === '\n首行', 'pre whitespace mismatch');
    check(actual.color === 'rgb(30, 80, 130)', 'relative stylesheet missing');
    check(actual.scripts === 1 && actual.originalScript === 41, 'relative original script changed or missing');
    check(errors.length === 0, 'page error');
    check(requests.length >= 3 && requests.every((url) => url.startsWith('http://127.0.0.1:5180/')), 'unexpected request');
    await page.screenshot({ path: 'output/playwright/hae005-copy-edge.png', fullPage: true });
    return { status: 'passed', browser: await page.context().browser().version(),
      mode: 'independent Edge via loopback HTTP; not native file chooser acceptance', actual, requests, errors };
  } finally { page.off('request', onRequest); page.off('pageerror', onError); }
}
