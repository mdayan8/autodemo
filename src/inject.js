// Runs inside every recorded page: draws a clean cursor that follows the real
// (Playwright) mouse, click ripples, hides scrollbars, blurs private selectors.
export function pageInit(blur) {
  const css =
    '::-webkit-scrollbar{display:none!important}html{scrollbar-width:none!important}' +
    (blur.length ? `${blur.join(',')}{filter:blur(7px)!important}` : '');
  let cursor;
  const mount = () => {
    if (!document.documentElement) return;
    if (!document.getElementById('__ad_css')) {
      const s = document.createElement('style');
      s.id = '__ad_css';
      s.textContent = css;
      document.documentElement.appendChild(s);
    }
    if (cursor && cursor.isConnected) return;
    cursor = document.createElement('div');
    cursor.innerHTML =
      '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M6 3 L6 23.5 L11.2 18.6 L14.8 26.6 L18.6 25 L15 17.2 L22 17.2 Z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      transform: 'translate(-6px,-3px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))', display: 'none',
    });
    try {
      const xy = JSON.parse(sessionStorage.getItem('__ad_xy') || 'null');
      if (xy) place(xy[0], xy[1]);
    } catch {}
    document.documentElement.appendChild(cursor);
  };
  const place = (x, y) => {
    cursor.style.display = '';
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  };
  addEventListener('mousemove', (e) => {
    mount();
    place(e.clientX, e.clientY);
    try { sessionStorage.setItem('__ad_xy', JSON.stringify([e.clientX, e.clientY])); } catch {}
  }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div');
    Object.assign(r.style, {
      position: 'fixed', left: e.clientX - 20 + 'px', top: e.clientY - 20 + 'px', width: '40px', height: '40px',
      borderRadius: '50%', border: '3px solid rgba(70,130,255,.9)', background: 'rgba(70,130,255,.15)',
      zIndex: '2147483646', pointerEvents: 'none', transform: 'scale(.3)', opacity: '1',
      transition: 'transform .5s cubic-bezier(.2,.8,.2,1), opacity .5s ease-out',
    });
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.5)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 600);
  }, true);
  document.addEventListener('DOMContentLoaded', mount);
  mount();
}
