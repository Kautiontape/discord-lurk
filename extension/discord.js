// Content script (isolated world) on discord.com. Adds a "capture from here"
// affordance to messages: primarily as an item injected into Discord's own
// right-click menu, falling back to a small hover button if that injection
// can't be made to work. Either way it asks the background worker to catch up
// from the chosen message and downloads the returned JSON.
//
// The token is NOT read here — the background worker reads it from the page's
// MAIN world via chrome.scripting. This script only needs the DOM.
(() => {
  if (window.__lurkHooked) return;
  window.__lurkHooked = true;

  let pendingCapture = null;   // {channelId, messageId} from the last right-click
  let menuInjectionWorks = false;
  let fallbackMode = false;    // flips on if native-menu injection never lands
  let capturing = false;

  // Message rows carry id="chat-messages-{channelId}-{messageId}" (older builds:
  // "chat-messages-{messageId}"). The id attribute is far more stable than
  // Discord's hashed CSS class names, so we anchor on it exclusively.
  function parseMessageEl(el) {
    if (!el || !el.id) return null;
    const parts = el.id.replace(/^chat-messages-/, '').split('-');
    if (parts.length >= 2 && parts[0] && parts[parts.length - 1]) {
      return { channelId: parts[0], messageId: parts[parts.length - 1] };
    }
    if (parts.length === 1 && parts[0]) return { channelId: null, messageId: parts[0] };
    return null;
  }

  function messageElFrom(node) {
    return node && node.closest ? node.closest('[id^="chat-messages-"]') : null;
  }

  // ---- primary path: inject into Discord's native context menu ----
  document.addEventListener(
    'contextmenu',
    (e) => {
      const parsed = parseMessageEl(messageElFrom(e.target));
      if (!parsed) return; // not a message — leave Discord's menu untouched
      pendingCapture = parsed;
      tryInjectIntoMenu(parsed);
    },
    true, // capture phase: record before Discord opens its menu; never preventDefault
  );

  function tryInjectIntoMenu(target) {
    let tries = 0;
    const poll = () => {
      if (pendingCapture !== target) return; // superseded by a newer right-click
      const menus = document.querySelectorAll('[role="menu"]');
      const menu = menus[menus.length - 1];
      if (menu) {
        if (!menu.querySelector('[data-lurk-item]')) injectMenuItem(menu, target);
        menuInjectionWorks = true;
        return;
      }
      if (++tries >= 8) {
        // ~400ms with no injectable menu, and never injected before → degrade.
        if (!menuInjectionWorks) fallbackMode = true;
        return;
      }
      setTimeout(poll, 50);
    };
    setTimeout(poll, 0);
  }

  function injectMenuItem(menu, target) {
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-lurk-item', '1');
    item.textContent = '⟳  lurk: capture from here';
    Object.assign(item.style, {
      padding: '6px 8px', margin: '2px 8px', borderRadius: '4px',
      fontSize: '14px', fontWeight: '500', color: '#dbdee1',
      cursor: 'pointer', userSelect: 'none',
    });
    item.addEventListener('mouseenter', () => {
      item.style.background = '#5865f2';
      item.style.color = '#fff';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
      item.style.color = '#dbdee1';
    });
    item.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenus();
      captureFrom(target);
    });
    menu.insertBefore(item, menu.firstChild);
  }

  function closeMenus() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }),
    );
  }

  // ---- fallback path: a hover button, attached lazily on first hover ----
  document.addEventListener('mouseover', (e) => {
    if (!fallbackMode) return;
    const msgEl = messageElFrom(e.target);
    if (!msgEl || msgEl.dataset.lurkHooked) return;
    attachHoverButton(msgEl);
  });

  function attachHoverButton(msgEl) {
    msgEl.dataset.lurkHooked = '1';
    const parsed = parseMessageEl(msgEl);
    if (!parsed) return;
    if (getComputedStyle(msgEl).position === 'static') msgEl.style.position = 'relative';
    const btn = document.createElement('button');
    btn.textContent = '⟳ from here';
    btn.title = 'lurk: capture from this message';
    Object.assign(btn.style, {
      position: 'absolute', top: '2px', right: '52px', zIndex: '1',
      font: '600 11px/1 monospace', color: '#0a0a0c', background: '#FFD000',
      border: 'none', borderRadius: '4px', padding: '3px 6px', cursor: 'pointer',
      opacity: '1', transition: 'opacity .12s',
    });
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      captureFrom(parsed);
    });
    msgEl.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    msgEl.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
    msgEl.appendChild(btn);
  }

  // ---- the action: ask the background to capture, then download ----
  async function captureFrom(target) {
    if (capturing) return;
    if (!target || !target.messageId) {
      toast('lurk: couldn’t identify that message — try again', 'err');
      return;
    }
    capturing = true;
    toast('lurk: capturing from here…', 'info', 0);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'LURK_CAPTURE_FROM',
        messageId: target.messageId,
        channelId: target.channelId || undefined,
      });
      if (res && res.ok) {
        const msgs = res.messages || [];
        if (msgs.length) {
          downloadJson(msgs, res.channelId);
          toast(`lurk: captured ${msgs.length} message${msgs.length === 1 ? '' : 's'} ✓ (downloading)`, 'ok');
        } else {
          toast('lurk: no messages from that point onward', 'ok');
        }
      } else {
        toast(`lurk: ${res ? res.error : 'capture failed'}`, 'err');
      }
    } catch (e) {
      toast(`lurk: ${(e && e.message) || 'capture failed'}`, 'err');
    } finally {
      capturing = false;
    }
  }

  function downloadJson(messages, channelId) {
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([JSON.stringify(messages, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lurk-${channelId || 'channel'}-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---- toast ----
  let toastEl = null;
  let toastTimer = null;
  function toast(text, kind = 'info', autoHideMs = 4000) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', bottom: '18px', right: '18px', zIndex: '2147483647',
        maxWidth: '320px', padding: '10px 14px', borderRadius: '8px',
        font: '500 13px/1.4 system-ui, sans-serif', color: '#E8E8EC',
        background: '#141417', border: '1px solid #2A2A30',
        boxShadow: '0 8px 30px rgba(0,0,0,.45)', pointerEvents: 'none',
        transition: 'opacity .2s',
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.borderColor = kind === 'err' ? '#FF5252' : kind === 'ok' ? '#4CAF50' : '#2A2A30';
    toastEl.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    if (autoHideMs > 0) toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, autoHideMs);
  }
})();
