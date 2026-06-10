// Content script (isolated world) on discord.com. Two jobs:
//   1. "capture from here" — adds an item to Discord's native right-click menu
//      (hover-button fallback if injection can't land) that asks the background
//      to catch up from the chosen message and downloads the returned JSON.
//   2. a blue "caught up to here" divider — drawn as a fixed overlay tracking
//      the last message lurk has archived for this channel.
//
// The token is NOT read here — the background reads it from the page's MAIN
// world via chrome.scripting. This script only needs the DOM.
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

  function findMessageEl(id) {
    return document.querySelector(`[id^="chat-messages-"][id$="-${id}"], [id="chat-messages-${id}"]`);
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
        injectMenuItem(menu, target);
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

  // The emoji quick-react bar at the top of a message menu is also made of
  // role="menuitem" buttons, but they're small squares. The real vertical rows
  // ("Add Reaction", "Reply", …) span most of the menu width — pick the first
  // of those, so we both copy the right style and land below the emoji bar.
  function firstListItem(menu) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const menuWidth = menu.getBoundingClientRect().width || 240;
    return items.find((el) => el.getBoundingClientRect().width > menuWidth * 0.6) || items[0] || null;
  }

  function injectMenuItem(menu, target) {
    if (menu.querySelector('[data-lurk-item]')) return;
    const sample = firstListItem(menu);
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-lurk-item', '1');
    if (sample) {
      // Inherit Discord's native item look, minus any transient focus/selected
      // state the sampled row happened to carry (else ours looks stuck-highlighted).
      item.className = sample.className
        .split(/\s+/)
        .filter((c) => !/focus|select|active|highlight/i.test(c))
        .join(' ');
    }
    item.textContent = 'lurk: capture from here';
    item.style.whiteSpace = 'nowrap';
    item.style.cursor = 'pointer';
    // Explicit highlight too, for builds where the hover style is JS-driven.
    item.addEventListener('mouseenter', () => { item.style.background = '#4752c4'; item.style.color = '#fff'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; item.style.color = ''; });
    item.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenus();
      captureFrom(target);
    });
    // First actual item: insert before the first existing menuitem (i.e. just
    // under the emoji quick-react bar), within the same group container.
    if (sample && sample.parentNode) sample.parentNode.insertBefore(item, sample);
    else menu.insertBefore(item, menu.firstChild);
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
    btn.textContent = '↓ from here';
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

  // ---- "caught up to here" divider (fixed overlay over the boundary message) ----
  let lastSeenId = null;
  let lastSeenChannel = null;
  let overlayEl = null;

  function currentChannelId() {
    const m = location.pathname.match(/^\/channels\/(?:@me|\d+)\/(\d+)/);
    return m ? m[1] : null;
  }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.className = 'lurk-divider';
    Object.assign(overlayEl.style, {
      position: 'fixed', height: '0', borderTop: '2px solid #3BA9FF',
      pointerEvents: 'none', zIndex: '999', display: 'none',
    });
    const tag = document.createElement('span');
    tag.textContent = 'caught up';
    Object.assign(tag.style, {
      position: 'absolute', right: '8px', top: '-9px',
      background: 'rgba(59,169,255,0.22)', color: '#bfe2ff',
      font: '700 10px/1 system-ui, sans-serif', padding: '3px 7px',
      borderRadius: '8px', letterSpacing: '.04em', textTransform: 'uppercase',
    });
    overlayEl.appendChild(tag);
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = 'none';
  }

  function positionOverlay() {
    if (!lastSeenId || currentChannelId() !== lastSeenChannel) return hideOverlay();
    const el = findMessageEl(lastSeenId);
    if (!el) return hideOverlay();
    const r = el.getBoundingClientRect();
    if (r.bottom < 56 || r.bottom > window.innerHeight) return hideOverlay(); // off-screen
    const o = ensureOverlay();
    o.style.display = 'block';
    o.style.left = `${r.left}px`;
    o.style.width = `${r.width}px`;
    o.style.top = `${r.bottom - 1}px`;
  }

  async function refreshLastSeen() {
    const ch = currentChannelId();
    if (!ch) { lastSeenChannel = null; lastSeenId = null; hideOverlay(); return; }
    if (ch === lastSeenChannel) return; // already fetched for this channel
    lastSeenChannel = ch;
    lastSeenId = null;
    hideOverlay();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'LURK_LAST_SEEN', channelId: ch });
      if (currentChannelId() === ch && res && res.ok) lastSeenId = res.lastSeenId || null;
    } catch (e) { /* ignore */ }
  }

  let rafPending = false;
  function schedulePosition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; positionOverlay(); });
  }
  window.addEventListener('scroll', schedulePosition, true); // capture: catches the inner scroller
  window.addEventListener('resize', schedulePosition);

  let tickScheduled = false;
  function scheduleTick() {
    if (tickScheduled) return;
    tickScheduled = true;
    setTimeout(async () => {
      tickScheduled = false;
      await refreshLastSeen(); // refetch when the channel changes
      positionOverlay();
    }, 200);
  }
  new MutationObserver(scheduleTick).observe(document.body, { childList: true, subtree: true });
  scheduleTick();
})();
