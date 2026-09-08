// Self-authored synthetic HTML, covered by the repository MIT license.
export const mappingCases = [
  { id: 'repeated', html: '<!doctype html><meta charset="utf-8"><h1>十处重复 🧪</h1>'
    + Array.from({ length: 10 }, (_, i) => `<p id="duplicate" data-order="${i}">相同文字 &amp; 😀</p>`).join('') },
  { id: 'nested', html: '<!doctype html><p>前<span>内<strong>深</strong>尾</span>后<!--分隔-->邻<br>末</p><table><tr><td>单元</td></tr></table>' },
  { id: 'entities', html: '\ufeff<!doctype html>\r\n<p>中文😀e\u0301 &amp; &#xA0; &#128512; &lt;tag&gt;\r\n第二行\r第三行\n末</p><pre>\n保留  空格\r\n下一行</pre>' },
  { id: 'noscript', html: '<!doctype html><noscript><p>脚本关闭也不是可改段落</p></noscript><p>普通正文</p>' },
  { id: 'contexts', html: '<!doctype html><title>标题</title><style>p{color:red}</style><script>window.ran=true</script><p>普通正文</p><textarea>输入值</textarea><form><p>表单文字</p></form><template><p>模板</p></template><svg><text>SVG</text><foreignObject><p>外来 HTML</p></foreignObject></svg><math><mtext>数学</mtext></math><canvas>后备文字</canvas><p contenteditable>页面编辑区</p>' },
  { id: 'foster', html: '<!doctype html><table>错位前<tr><td>单元</td></tr>错位后</table>' },
  { id: 'adoption', html: '<!doctype html><b><i>甲</b>乙</i><p>正文也保守只读</p>' },
  { id: 'parse-error', html: '<!doctype html><p id=x id=y>重复属性</p><p>整页只读</p>' },
  { id: 'no-doctype', html: '<p>缺少 doctype 可以核对</p>' },
  { id: 'pre-leading-newline', html: '<!doctype html><pre>\n开头 LF 被解析器消耗</pre>' },
] as const;
