// Self-authored public fixture. The parent test constructs its own expected bytes.
export const css = 'body{font-family:Segoe UI,sans-serif;margin:32px}h1{color:rgb(12,34,56)}td{padding:12px;border:1px solid #888}';
export const source = '\ufeff<!doctype html>\r\n<html lang="zh-CN"><head><meta charset="utf-8"><title>M2 自制报告</title>'
  + '<link rel="stylesheet" href="keep.css"></head><body>\r\n'
  + '<h1>年度 &#65; 报告 😀</h1><p id="date">2025-01-01</p>\r\n'
  + '<table><tbody><tr><td id="label">一 &amp; 二</td><td id="amount">1000.00</td><td id="memo">原摘要</td></tr></tbody></table>\r\n'
  + '<p id="untouched">重复文字 &amp; 保留原样</p><!-- 原始备注 -->\r\n'
  + '<script>document.documentElement.dataset.scriptRan="17";document.documentElement.dataset.brandColor=getComputedStyle(document.querySelector("h1")).color;document.documentElement.dataset.browser=navigator.userAgent;</script>\r\n'
  + '</body></html>\r\n';
export const edits = [
  ['h1', '年度 B 报告 🧪'], ['#date', '2026-09-10'], ['#label', '核对 <&>'],
  ['#amount', '1234.56'], ['#memo', '服务费用已复核'],
] as const;
