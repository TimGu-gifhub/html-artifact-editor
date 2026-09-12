import { useEffect, useRef, useState } from 'react';
import type { TextDecoration } from '../contracts/text-geometry.ts';

/**
 * 文字装饰层（HAE-009 就地校稿）：运行在 Main 创建的透明、不可聚焦、鼠标完全
 * 穿透的独立原生窗口中，preload 只公开 window.haeDecoration。这里只按 Main 核验
 * 后的矩形画边框（hover 细虚线、selected 明显实线）；背景全透明，没有文字、
 * 表单或按钮，绝不向用户 Preview DOM 加节点、属性或样式。
 *
 * 编辑器页面 CSP 为 style-src 'self'，动态矩形不能用内联样式定位，因此边框画在
 * 全窗 canvas 上（2D 绘制不受 style-src 约束）。矩形坐标为该透明窗的 DIP，
 * preload 已用 isTextDecoration 校验形状与数量上限（每种最多 80 个矩形）。
 */

const EMPTY: TextDecoration = { hover: null, selected: null };

function accentColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return value || '#2f6feb';
}

function draw(canvas: HTMLCanvasElement, state: TextDecoration): void {
  const ratio = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const color = accentColor();
  const stroke = (shape: TextDecoration['hover'], lineWidth: number, dash: readonly number[], inset: number): void => {
    if (!shape) return;
    context.setLineDash([...dash]);
    context.lineWidth = lineWidth;
    context.strokeStyle = color;
    for (const rect of shape.rects) {
      const w = rect.width - inset * 2;
      const h = rect.height - inset * 2;
      if (w <= 0 || h <= 0) continue;
      context.strokeRect(rect.x + inset, rect.y + inset, w, h);
    }
  };
  stroke(state.hover, 1, [4, 3], 0.5);
  stroke(state.selected, 2, [], 1);
  context.setLineDash([]);
}

export function Decoration() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<TextDecoration>(EMPTY);
  const [state, setState] = useState<TextDecoration>(EMPTY);
  stateRef.current = state;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('decoration');
    const api = window.haeDecoration ?? null;
    const off = api ? api.onState(next => setState(next)) : null;
    const onResize = () => {
      const canvas = canvasRef.current;
      if (canvas) draw(canvas, stateRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => {
      off?.();
      window.removeEventListener('resize', onResize);
      root.classList.remove('decoration');
    };
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) draw(canvas, state);
  }, [state]);
  return <canvas ref={canvasRef} className="decoration-canvas" aria-hidden="true" />;
}
