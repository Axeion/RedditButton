import './styles.css';
import { ClockSync } from './clock.ts';
import { sound } from './sound.ts';
import { BANDS, bandById, bandFor, type BandId } from '@shared/bands.ts';
import type {
  ServerMessage, ClientMessage, PressDTO, ChatDTO, ModInfo, ChatSettingsDTO,
} from '@shared/protocol.ts';

// --- DOM --------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const els = {
  flash: $('flash'),
  watching: $('watching'),
  loaded: $('loaded'),
  mute: $<HTMLButtonElement>('mute'),
  muteIcon: $('mute-icon'),
  clock: $('clock'),
  time: $('time'),
  clockSub: $('clock-sub'),
  press: $<HTMLButtonElement>('press'),
  pressLabel: $('press-label'),
  you: $('you'),
  hint: $('hint'),
  gauge: $('gauge'),
  gaugeLegend: $('gauge-legend'),
  gaugeTotal: $('gauge-total'),
  board: $<HTMLOListElement>('board'),
  calls: $<HTMLUListElement>('calls'),
  chat: $('chat'),
  chatForm: $<HTMLFormElement>('chat-form'),
  chatInput: $<HTMLInputElement>('chat-input'),
  chatError: $('chat-error'),
  toast: $('toast'),
  modal: $('modal'),
  modalBody: $('modal-body'),
  modalX: $<HTMLButtonElement>('modal-x'),
};

// --- State ------------------------------------------------------------------

const clock = new ClockSync();

const state = {
  connected: false,
  spectator: false,
  name: null as string | null,
  hasPressed: false,
  myPress: null as PressDTO | null,
  expiresAt: 0,
  eraId: 0,
  roundSeconds: 90,
  mod: null as ModInfo | null,
  chatSettings: { slowModeSeconds: 0, locked: false } as ChatSettingsDTO,
  boardScope: 'era' as 'era' | 'all',
  boards: { era: [] as PressDTO[], all: [] as PressDTO[] },
  pressInFlight: false,
};

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let pingTimer: number | undefined;

// --- Small helpers ----------------------------------------------------------

function toast(text: string, ms = 3200): void {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  window.setTimeout(() => els.toast.classList.remove('show'), ms);
}

function send(msg: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function fmtSecs(n: number): string {
  return `${n.toFixed(2)}s`;
}

// --- Countdown --------------------------------------------------------------

/**
 * The only place the displayed number is computed. Interpolating locally
 * against the synced clock means a jittery connection never makes the
 * countdown stutter or jump backwards.
 */
function frame(): void {
  const left = state.expiresAt
    ? Math.max(0, Math.min(state.roundSeconds, (state.expiresAt - clock.now()) / 1000))
    : state.roundSeconds;

  els.time.textContent = left.toFixed(2);

  // The clock wears the colour you would earn by pressing right now — so you
  // can watch your reward tier climb while your nerve drains.
  const band = bandFor(left);
  els.clock.style.color = band.hex;

  const urgent = left < 10;
  els.clock.classList.toggle('is-urgent', urgent);

  if (left <= 0) {
    els.clockSub.textContent = 'flatlined';
  } else if (urgent) {
    els.clockSub.textContent = `${band.label.toLowerCase()} territory — someone press`;
  } else {
    els.clockSub.textContent = 'until it flatlines';
  }

  // Heartbeat accelerates under fifteen seconds: 1100ms down to ~260ms.
  if (left > 0 && left < 15) {
    const t = 1 - left / 15;
    sound.heartbeat(1100 - t * 840, t);
  }

  requestAnimationFrame(frame);
}

// --- Rendering --------------------------------------------------------------

function renderPressButton(): void {
  if (!state.connected) {
    els.press.disabled = true;
    els.pressLabel.textContent = '…';
    els.press.classList.remove('is-spent');
    return;
  }

  if (state.spectator) {
    els.press.disabled = true;
    els.press.classList.add('is-spent');
    els.pressLabel.textContent = 'WATCHING';
    els.press.style.color = '';
    return;
  }

  if (state.hasPressed && state.myPress) {
    const band = bandById(state.myPress.band);
    els.press.disabled = true;
    els.press.classList.add('is-spent');
    els.press.style.color = band.textHex;
    els.pressLabel.textContent = `SPENT\n${fmtSecs(state.myPress.secondsLeft)}`;
    els.pressLabel.style.whiteSpace = 'pre-line';
    return;
  }

  els.press.disabled = state.pressInFlight;
  els.press.classList.remove('is-spent');
  els.press.style.color = '';
  els.pressLabel.textContent = state.pressInFlight ? '…' : 'PRESS';
}

function renderYou(): void {
  els.you.textContent = '';

  if (state.spectator) {
    els.you.append('watching only — too many new players from your network');
    els.hint.textContent = 'You can follow along and see every press. Your press unlocks later.';
    return;
  }

  if (!state.name) {
    els.you.append('connecting…');
    return;
  }

  els.you.append('you are ');
  const strong = document.createElement('strong');
  strong.textContent = state.name;
  if (state.myPress) strong.style.color = bandById(state.myPress.band).textHex;
  els.you.append(strong);

  if (state.myPress) {
    const band = bandById(state.myPress.band);
    els.hint.textContent = `${band.label} — ${band.blurb} You're done; now watch everyone else sweat.`;
  } else {
    els.hint.textContent = 'One press. Ever. The later you press, the higher you rank.';
  }
}

function renderBoard(): void {
  const list = state.boardScope === 'era' ? state.boards.era : state.boards.all;
  els.board.textContent = '';

  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent =
      state.boardScope === 'era' ? 'Nobody has pressed this era yet.' : 'No presses yet.';
    els.board.append(li);
    return;
  }

  for (const p of list) {
    const li = document.createElement('li');
    if (state.name && p.name === state.name) li.classList.add('is-me');

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `${p.rank ?? ''}`;

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name;
    who.style.color = bandById(p.band).textHex;

    const secs = document.createElement('span');
    secs.className = 'secs';
    secs.textContent = fmtSecs(p.secondsLeft);

    li.append(rank, who, secs);
    els.board.append(li);
  }
}

function renderGauge(counts: Record<BandId, number>, total: number): void {
  els.gauge.textContent = '';
  els.gaugeLegend.textContent = '';
  els.gaugeTotal.textContent = `${total} press${total === 1 ? '' : 'es'}`;

  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'gauge-empty';
    empty.textContent = 'no presses yet';
    els.gauge.append(empty);
    return;
  }

  for (const band of BANDS) {
    const n = counts[band.id] ?? 0;
    if (n === 0) continue;

    const seg = document.createElement('div');
    seg.className = 'gauge-seg';
    seg.style.background = band.hex;
    seg.style.flexGrow = String(n);
    seg.style.flexBasis = '0';
    seg.title = `${band.label}: ${n}`;
    els.gauge.append(seg);

    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'swatch';
    sw.style.background = band.hex;
    item.append(sw, `${band.label} ${n}`);
    els.gaugeLegend.append(item);
  }
}

function renderCalls(list: PressDTO[]): void {
  els.calls.textContent = '';

  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No close calls yet. Nobody has held their nerve.';
    els.calls.append(li);
    return;
  }

  for (const p of list) {
    const band = bandById(p.band);
    const li = document.createElement('li');

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name;
    who.style.color = band.textHex;

    const secs = document.createElement('span');
    secs.className = 'secs';
    secs.style.color = band.hex;
    secs.textContent = fmtSecs(p.secondsLeft);

    li.append(who, secs);
    els.calls.append(li);
  }
}

function nearBottom(): boolean {
  return els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 80;
}

function modButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'mod-btn';
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function appendChat(m: ChatDTO): void {
  const stick = nearBottom();

  const div = document.createElement('div');
  div.className = 'msg';
  div.dataset.id = String(m.id);

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = m.name;
  who.style.color = m.band ? bandById(m.band).textHex : 'var(--faint)';

  const body = document.createElement('span');
  body.textContent = m.body;

  div.append(who, body);

  // Controls are rendered only for signed-in mods, but that is cosmetic — the
  // server re-authorises every action against the session cookie regardless.
  if (state.mod) {
    const tools = document.createElement('span');
    tools.className = 'mod-tools';
    tools.append(
      modButton('del', `Delete this message from ${m.name}`, () =>
        send({ type: 'modDelete', messageId: m.id })),
      modButton('purge', `Delete everything ${m.name} said this era`, () => {
        if (confirm(`Delete every message from ${m.name} this era?`)) {
          send({ type: 'modPurge', messageId: m.id });
        }
      }),
      modButton('5m', `Time ${m.name} out for 5 minutes`, () =>
        send({ type: 'modTimeout', messageId: m.id, minutes: 5 })),
      modButton('1h', `Time ${m.name} out for an hour`, () =>
        send({ type: 'modTimeout', messageId: m.id, minutes: 60 })),
    );
    div.append(tools);
  }

  els.chat.append(div);

  while (els.chat.childElementCount > 200) els.chat.firstElementChild?.remove();
  if (stick) els.chat.scrollTop = els.chat.scrollHeight;
}

function removeMessages(ids: number[]): void {
  const wanted = new Set(ids.map(String));
  for (const el of [...els.chat.children]) {
    const id = (el as HTMLElement).dataset?.id;
    if (id && wanted.has(id)) el.remove();
  }
}

/** Mod-only toolbar above the chat input: slow mode and lockdown. */
function renderModBar(): void {
  let bar = document.getElementById('mod-bar');
  if (!state.mod) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'mod-bar';
    bar.className = 'mod-bar';
    els.chatForm.before(bar);
  }
  bar.textContent = '';

  const who = document.createElement('span');
  who.className = 'mod-who';
  who.textContent = `${state.mod.username} (${state.mod.role})`;
  bar.append(who);

  for (const secs of [0, 5, 15, 30]) {
    const b = modButton(
      secs === 0 ? 'slow off' : `${secs}s`,
      secs === 0 ? 'Turn slow mode off' : `Slow mode: one message per ${secs}s`,
      () => send({ type: 'modSlowMode', seconds: secs }),
    );
    if (state.chatSettings.slowModeSeconds === secs) b.classList.add('is-on');
    bar.append(b);
  }

  const lock = modButton(
    state.chatSettings.locked ? 'unlock' : 'lock',
    state.chatSettings.locked ? 'Unlock chat' : 'Freeze chat entirely',
    () => send({ type: 'modLock', locked: !state.chatSettings.locked }),
  );
  if (state.chatSettings.locked) lock.classList.add('is-danger');
  bar.append(lock);

  const out = document.createElement('a');
  out.href = '#';
  out.className = 'mod-out';
  out.textContent = 'sign out';
  out.addEventListener('click', (e) => {
    e.preventDefault();
    const f = document.createElement('form');
    f.method = 'post';
    f.action = '/mod/logout';
    document.body.append(f);
    f.submit();
  });
  bar.append(out);
}

function applyChatSettings(s: ChatSettingsDTO): void {
  state.chatSettings = s;
  els.chatInput.disabled = state.spectator || s.locked;
  els.chatInput.placeholder = s.locked
    ? 'Chat is locked by a moderator.'
    : s.slowModeSeconds > 0
      ? `Slow mode: one message per ${s.slowModeSeconds}s`
      : 'Say something…';
  renderModBar();
}

function systemLine(text: string): void {
  const div = document.createElement('div');
  div.className = 'msg is-system';
  div.textContent = text;
  els.chat.append(div);
  els.chat.scrollTop = els.chat.scrollHeight;
}

function fireFlash(): void {
  els.flash.classList.remove('fire');
  void els.flash.offsetWidth; // restart the animation
  els.flash.classList.add('fire');
}

// --- Share modal ------------------------------------------------------------

function openShareModal(press: PressDTO): void {
  const band = bandById(press.band);
  const url = `${location.origin}/p/${press.id}`;
  els.modalBody.textContent = '';

  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.style.background = band.hex;
  if (band.id === 'gold') pill.style.color = '#3A2A00';
  pill.textContent = band.label.toUpperCase();

  const h3 = document.createElement('h3');
  h3.textContent = band.blurb;

  const time = document.createElement('div');
  time.className = 'big-time';
  time.style.color = band.hex;
  time.textContent = fmtSecs(press.secondsLeft);

  const sub = document.createElement('div');
  sub.className = 'muted';
  sub.textContent = press.rank
    ? `Rank #${press.rank} this era · ${press.name}`
    : `${press.name}`;

  const img = document.createElement('img');
  img.src = `/card/${press.id}.png`;
  img.alt = `${press.name} pressed at ${fmtSecs(press.secondsLeft)}`;
  img.loading = 'lazy';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const copy = document.createElement('button');
  copy.className = 'primary';
  copy.type = 'button';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = 'Copied';
      window.setTimeout(() => (copy.textContent = 'Copy link'), 1600);
    } catch {
      // Clipboard is blocked without a secure context or permission; give them
      // something they can select by hand instead of failing silently.
      toast(url, 8000);
    }
  });

  const open = document.createElement('a');
  open.href = `/p/${press.id}`;
  open.target = '_blank';
  open.rel = 'noopener';
  open.textContent = 'Open card';

  actions.append(copy, open);
  els.modalBody.append(pill, h3, time, sub, img, actions);
  els.modal.hidden = false;
}

function closeModal(): void {
  els.modal.hidden = true;
}

els.modalX.addEventListener('click', closeModal);
els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// --- Message handling -------------------------------------------------------

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'hello': {
      state.connected = true;
      state.spectator = msg.spectator;
      state.name = msg.name;
      state.hasPressed = msg.hasPressed;
      state.myPress = msg.myPress;
      state.expiresAt = msg.expiresAt;
      state.eraId = msg.eraId;
      state.roundSeconds = msg.roundSeconds;
      state.mod = msg.mod;
      clock.sample(Date.now(), msg.serverTime);
      applyChatSettings(msg.chatSettings);
      renderPressButton();
      renderYou();
      break;
    }

    case 'pong':
      clock.sample(msg.t, msg.serverTime);
      break;

    case 'state':
      state.expiresAt = msg.expiresAt;
      state.eraId = msg.eraId;
      els.watching.textContent = String(msg.watching);
      els.loaded.textContent = String(msg.loaded);
      break;

    case 'press': {
      state.expiresAt = msg.expiresAt;

      if (msg.mine) {
        state.hasPressed = true;
        state.myPress = msg.press;
        state.pressInFlight = false;
        sound.confirm();
        renderPressButton();
        renderYou();
        openShareModal(msg.press);
      }

      if (msg.closeCall) {
        fireFlash();
        if (!msg.mine) sound.klaxon();
        systemLine(
          `${msg.press.name} saved it at ${fmtSecs(msg.press.secondsLeft)} — ${bandById(msg.press.band).label}.`,
        );
      }
      break;
    }

    case 'chat':
      appendChat(msg.message);
      break;

    case 'chatDelete':
      removeMessages(msg.ids);
      break;

    case 'chatSettings':
      applyChatSettings(msg.settings);
      if (msg.settings.locked) systemLine('A moderator locked the chat.');
      else if (msg.settings.slowModeSeconds > 0) {
        systemLine(`Slow mode on: one message per ${msg.settings.slowModeSeconds}s.`);
      }
      break;

    case 'modResult':
      toast(msg.message, msg.ok ? 2600 : 4000);
      break;

    case 'chatBackfill':
      els.chat.textContent = '';
      for (const m of msg.messages) appendChat(m);
      els.chat.scrollTop = els.chat.scrollHeight;
      break;

    case 'leaderboard':
      state.boards.era = msg.era;
      state.boards.all = msg.allTime;
      renderBoard();
      break;

    case 'gauge':
      renderGauge(msg.gauge.counts, msg.gauge.total);
      break;

    case 'closeCalls':
      renderCalls(msg.presses);
      break;

    case 'flatline': {
      // Everyone's press comes back; the room starts clean.
      state.eraId = msg.eraId;
      state.expiresAt = msg.expiresAt;
      state.hasPressed = false;
      state.myPress = null;
      state.pressInFlight = false;
      sound.flatline();
      fireFlash();
      els.chat.textContent = '';
      const survived = Math.round(msg.deadEra.durationMs / 1000);
      systemLine(
        `Era ${msg.deadEra.id} flatlined after ${survived}s and ${msg.deadEra.totalPresses} presses. ` +
          `Era ${msg.eraId} begins — everyone gets their press back.`,
      );
      toast(`It died. Era ${msg.eraId} begins — you have your press back.`, 6000);
      renderPressButton();
      renderYou();
      break;
    }

    case 'error': {
      state.pressInFlight = false;
      if (msg.code === 'already_pressed' || msg.code === 'network_pressed') {
        state.hasPressed = true;
      }
      renderPressButton();
      if (msg.code.startsWith('rate') || msg.code === 'duplicate' || msg.code === 'empty') {
        els.chatError.textContent = msg.message;
        window.setTimeout(() => (els.chatError.textContent = ''), 3000);
      } else {
        toast(msg.message);
      }
      break;
    }
  }
}

// --- Connection -------------------------------------------------------------

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  clock.reset();

  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    // A short burst of pings converges the clock offset quickly, then we keep
    // one every 15s to track drift.
    for (let i = 0; i < 5; i++) {
      window.setTimeout(() => send({ type: 'ping', t: Date.now() }), i * 120);
    }
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => send({ type: 'ping', t: Date.now() }), 15_000);
  });

  ws.addEventListener('message', (ev) => {
    try {
      handle(JSON.parse(ev.data as string) as ServerMessage);
    } catch {
      /* a frame we don't understand is not worth crashing the page over */
    }
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    window.clearInterval(pingTimer);
    renderPressButton();

    reconnectAttempt++;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
    if (reconnectAttempt === 1) els.clockSub.textContent = 'reconnecting…';
    window.setTimeout(connect, delay);
  });

  ws.addEventListener('error', () => ws?.close());
}

/**
 * Identity is minted over HTTP before the socket opens, because an upgrade
 * request can read cookies but cannot set one.
 */
/**
 * Render a Turnstile challenge and resolve with its token.
 *
 * Only ever reached when the server refuses to mint a new identity without
 * one. A returning player with a valid cookie never sees this, and the press
 * itself is never gated — a widget appearing with three seconds on the clock
 * would be the end of the game.
 */
function solveTurnstile(siteKey: string): Promise<string | null> {
  return new Promise((resolve) => {
    els.modalBody.textContent = '';

    const h3 = document.createElement('h3');
    h3.textContent = 'One quick check';
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.textContent = 'Confirming you are a person, not a script farming presses.';
    const host = document.createElement('div');
    host.id = 'turnstile-host';
    host.style.margin = '18px auto';

    els.modalBody.append(h3, sub, host);
    els.modal.hidden = false;

    let settled = false;
    const done = (token: string | null) => {
      if (settled) return;
      settled = true;
      els.modal.hidden = true;
      resolve(token);
    };

    const render = () => {
      const ts = (window as unknown as { turnstile?: {
        render: (el: HTMLElement, o: Record<string, unknown>) => void;
      } }).turnstile;
      if (!ts) return done(null);
      ts.render(host, {
        sitekey: siteKey,
        callback: (token: string) => done(token),
        'error-callback': () => done(null),
        'timeout-callback': () => done(null),
      });
    };

    if ((window as unknown as { turnstile?: unknown }).turnstile) {
      render();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = render;
    // If Cloudflare's script itself can't load, don't strand the visitor at a
    // blank modal — fall through and let the server decide.
    script.onerror = () => done(null);
    document.head.append(script);

    window.setTimeout(() => done(null), 20_000);
  });
}

async function fetchIdentity(turnstileToken?: string): Promise<Response> {
  const url = turnstileToken
    ? `/api/identity?turnstile=${encodeURIComponent(turnstileToken)}`
    : '/api/identity';
  return fetch(url, { credentials: 'same-origin' });
}

async function boot(): Promise<void> {
  try {
    let res = await fetchIdentity();

    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        siteKey?: string;
      };
      if (body.error === 'turnstile' && body.siteKey) {
        const token = await solveTurnstile(body.siteKey);
        if (token) res = await fetchIdentity(token);
      }
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (body.message) toast(body.message, 7000);
    }
  } catch {
    toast('Could not reach the server. Retrying…');
  }
  connect();
}

// --- Input ------------------------------------------------------------------

els.press.addEventListener('click', () => {
  sound.primeFromGesture();
  if (state.hasPressed || state.spectator || state.pressInFlight || !state.connected) return;
  state.pressInFlight = true;
  renderPressButton();
  send({ type: 'press' });
  // If the server never answers, don't leave the button stuck.
  window.setTimeout(() => {
    if (state.pressInFlight) {
      state.pressInFlight = false;
      renderPressButton();
    }
  }, 5000);
});

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const body = els.chatInput.value.trim();
  if (!body) return;
  send({ type: 'chat', body });
  els.chatInput.value = '';
});

els.mute.addEventListener('click', () => {
  const on = sound.toggle();
  els.muteIcon.textContent = on ? '🔊' : '🔇';
  els.mute.setAttribute('aria-pressed', on ? 'true' : 'false');
  els.mute.title = on ? 'Sound is on' : 'Sound is off';
});

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('is-on');
    tab.classList.add('is-on');
    state.boardScope = tab.dataset.scope === 'all' ? 'all' : 'era';
    renderBoard();
  });
}

// Spacebar presses the button — this game is about reaction time.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  els.press.click();
});

// --- Go ---------------------------------------------------------------------

els.muteIcon.textContent = sound.isOn ? '🔊' : '🔇';
els.mute.setAttribute('aria-pressed', sound.isOn ? 'true' : 'false');
renderPressButton();
renderGauge({} as Record<BandId, number>, 0);
renderBoard();
renderCalls([]);
requestAnimationFrame(frame);
void boot();
