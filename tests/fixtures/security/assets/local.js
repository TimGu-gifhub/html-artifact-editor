window.externalRan = true;
document.getElementById('dynamic').textContent = '脚本生成（只读）';
document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<p>只读 Shadow DOM</p>';
document.getElementById('canvas').getContext('2d').fillRect(0, 0, 10, 10);
