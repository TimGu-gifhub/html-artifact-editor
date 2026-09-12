import { createRoot } from 'react-dom/client';
import './shell.css';
import { Decoration } from './decoration.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Missing UI root');

if (window.haeDecoration) {
  // 文字装饰层：透明、不可聚焦、鼠标穿透的独立原生窗口。只有边框绘制，没有
  // haeWorkspace/haeDesktop；App/store/input 模块只在正常产品分支动态加载。
  createRoot(root).render(<Decoration />);
} else if (window.haeDesktop && window.haeWorkspace) {
  void import('./app.tsx').then(({ App }) => createRoot(root).render(<App />));
} else {
  // HAE-001 toolchain verification shell, kept for the legacy smoke tests.
  const ready = window.haeBootstrap?.contractVersion === 1
    && window.haeBootstrap.stage === 'toolchain';
  createRoot(root).render(
    <main>
      <h1>HTML Artifact Editor</h1>
      <p>HAE-001 · 工具链验证壳</p>
      <p role="status" data-bootstrap={ready ? 'ready' : 'error'}>
        {ready ? '可信 UI 与独立 preload 已加载。' : '启动失败：可信 preload 未就绪。'}
      </p>
      <p>尚未实现打开、选字、修改或保存。下方仅显示内置静态样例。</p>
    </main>,
  );
}
