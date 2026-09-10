import { createRoot } from 'react-dom/client';
import './shell.css';
import { App } from './app.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Missing UI root');

if (window.haeDesktop && window.haeWorkspace) {
  createRoot(root).render(<App />);
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
