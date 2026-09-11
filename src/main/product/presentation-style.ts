/**
 * 屏幕校稿期间原页面标签页按钮的选中/未选中外观（HAE-009 就地校稿交接允许
 * 的唯一 Main 新增文件）。纯 CSS 字符串生成：不读取 DOM、文件或环境，不发起
 * IO，不做任何授权决定。tabs 只接收 Main 生成的安全数字 CSS 路径
 * （:root:nth-child(N) > :nth-child(M)…，见 core/parser/presentation.ts）或
 * null；任何不匹配的输入整体跳过，CSS 注入无从发生。规则由 Main 放进
 * @media screen，本函数不产出 @media、url() 或任何网络/行为特性。它只改变
 * 屏幕上的标签外观，使源文件默认 active 标签不与实际保留的正文错位；不修改
 * 属性，不是选择或写盘依据。
 */

const SAFE_NUMERIC_PATH = /^:root:nth-child\([0-9]+\)(?: > :nth-child\([0-9]+\))*$/u;

export function tabPresentationCss(tabs: readonly (string | null)[], active: number): string {
  if (!Number.isSafeInteger(active) || active < 0 || active >= tabs.length) return '';
  const activeTab = tabs[active];
  // 实际显示的正文没有可定位的标签按钮时，不得只 mute 其余标签造成误导。
  if (activeTab === null || activeTab === undefined || !SAFE_NUMERIC_PATH.test(activeTab)) return '';
  const rules: string[] = [];
  for (let index = 0; index < tabs.length; ++index) {
    const tab = tabs[index];
    if (tab === null || tab === undefined || !SAFE_NUMERIC_PATH.test(tab)) continue;
    rules.push(index === active
      ? `${tab}{opacity:1!important;font-weight:600!important;text-decoration:underline 2px!important;text-underline-offset:3px!important;}`
      : `${tab}{opacity:.65!important;font-weight:400!important;text-decoration:none!important;}`);
  }
  return rules.join('');
}
