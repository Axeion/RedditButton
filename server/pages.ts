import { bandById } from '@shared/bands.ts';
import type { PressDTO, EraSummary } from '@shared/protocol.ts';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const SHELL_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #fff; color: #111315;
  }
  a { color: #E03131; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }
  .mark { font-weight: 800; letter-spacing: .14em; color: #E03131; text-decoration: none; font-size: 15px; }
  .tag { color: #8A8F96; font-size: 14px; margin-top: 4px; }
  h1 { font-size: 30px; margin: 28px 0 6px; letter-spacing: -.02em; }
  .sub { color: #6B7075; margin: 0 0 28px; }
  .cta {
    display: inline-block; background: #E03131; color: #fff; text-decoration: none;
    font-weight: 700; padding: 13px 26px; border-radius: 999px; margin-top: 8px;
  }
  .card { border: 1px solid #ECEDEF; border-radius: 14px; padding: 20px; margin-bottom: 14px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .muted { color: #8A8F96; font-size: 14px; }
  .pill {
    display: inline-block; padding: 3px 11px; border-radius: 999px;
    font-size: 12px; font-weight: 700; color: #fff; letter-spacing: .04em;
  }
  .big { font-size: 34px; font-weight: 800; letter-spacing: -.02em; }
  ol { padding-left: 20px; margin: 10px 0 0; }
  li { margin: 3px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td { padding: 4px 0; }
  td.r { text-align: right; color: #6B7075; font-variant-numeric: tabular-nums; }
`;

function shell(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${SHELL_CSS}</style>
${head}
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

/**
 * Standalone page behind a shared link. Kept server-rendered so link previews
 * (which never run JS) get real Open Graph tags and a real image.
 */
export function sharePage(press: PressDTO, origin: string): string {
  const band = bandById(press.band);
  const time = press.secondsLeft.toFixed(2);
  const title = `${press.name} pressed at ${time}s`;
  const desc = press.rank
    ? `${band.label} flair, rank #${press.rank} in era ${press.eraId}. ${band.blurb}`
    : `${band.label} flair in era ${press.eraId}. ${band.blurb}`;
  const img = `${origin}/card/${press.id}.png`;

  const head = `
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(`${origin}/p/${press.id}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="description" content="${esc(desc)}">`;

  const body = `
<a class="mark" href="/">DEADMAN</a>
<div class="tag">It stays alive while someone still presses.</div>
<h1>${esc(press.name)} held out to <span style="color:${band.hex}">${time}s</span></h1>
<p class="sub">
  <span class="pill" style="background:${band.hex}">${esc(band.label.toUpperCase())}</span>
  &nbsp;${esc(band.blurb)}${press.rank ? ` &middot; rank #${press.rank} of era ${press.eraId}` : ''}
</p>
<img src="${esc(img)}" alt="${esc(title)}" style="width:100%;border-radius:14px;border:1px solid #ECEDEF">
<p><a class="cta" href="/">Take your press &rarr;</a></p>
<p class="muted">One press per player. The clock only stops if everybody blinks.</p>`;

  return shell(title, head, body);
}

export function graveyardPage(eras: EraSummary[], longestMs: number, origin: string): string {
  const head = `
<meta property="og:title" content="Deadman - the Graveyard">
<meta property="og:description" content="Every era that ran out of nerve.">
<meta property="og:url" content="${esc(`${origin}/graveyard`)}">
<meta name="description" content="Every Deadman era that ran out of nerve.">`;

  const body = `
<a class="mark" href="/">DEADMAN</a>
<div class="tag">It stays alive while someone still presses.</div>
<h1>The Graveyard</h1>
<p class="sub">
  ${eras.length} era${eras.length === 1 ? '' : 's'} have flatlined.
  ${longestMs > 0 ? `Longest survival: <strong>${duration(longestMs)}</strong>.` : ''}
</p>
${
  eras.length === 0
    ? `<div class="card"><strong>Nothing here yet.</strong><div class="muted">
       The button has never died. Keep it that way.</div></div>`
    : eras
        .map(
          (e) => `
<div class="card">
  <div class="row">
    <div><span class="big">Era ${e.id}</span></div>
    <div class="muted">survived ${duration(e.durationMs)} &middot; ${e.totalPresses} press${e.totalPresses === 1 ? '' : 'es'}</div>
  </div>
  ${
    e.lastHand
      ? `<div class="muted" style="margin-top:8px">The Last Hand:
         <strong style="color:${bandById(e.lastHand.band).textHex}">${esc(e.lastHand.name)}</strong>
         at ${e.lastHand.secondsLeft.toFixed(2)}s - then nobody came.</div>`
      : `<div class="muted" style="margin-top:8px">Nobody ever pressed. It died alone.</div>`
  }
  ${
    e.top.length
      ? `<table>${e.top
          .map(
            (p, i) => `<tr>
        <td>${i + 1}. <span class="pill" style="background:${bandById(p.band).hex}">${esc(bandById(p.band).label.toUpperCase())}</span>
        <strong>${esc(p.name)}</strong></td>
        <td class="r">${p.secondsLeft.toFixed(2)}s</td>
      </tr>`,
          )
          .join('')}</table>`
      : ''
  }
</div>`,
        )
        .join('')
}
<p><a class="cta" href="/">Back to the button &rarr;</a></p>`;

  return shell('Deadman - the Graveyard', head, body);
}

/**
 * Mod sign-in. Server-rendered and deliberately plain — it is a login form, it
 * does not need the game's JavaScript, and keeping it separate means a bug in
 * the game bundle can never lock moderators out.
 */
export function modLoginPage(error?: string, next = '/'): string {
  const head = '<meta name="robots" content="noindex, nofollow">';
  const body = `
<a class="mark" href="/">DEADMAN</a>
<div class="tag">Moderator sign-in</div>
<h1>Sign in</h1>
${error ? `<p class="sub" style="color:#E03131">${esc(error)}</p>` : '<p class="sub">Signed-in moderators get inline controls on the main page.</p>'}
<form method="post" action="/mod/login" class="card" style="max-width:380px">
  <input type="hidden" name="next" value="${esc(next)}">
  <label style="display:block;margin-bottom:10px">
    <div class="muted" style="margin-bottom:4px">Username</div>
    <input name="username" autocomplete="username" required
           style="width:100%;padding:10px 12px;border:1px solid #ECEDEF;border-radius:8px;font-size:15px">
  </label>
  <label style="display:block;margin-bottom:16px">
    <div class="muted" style="margin-bottom:4px">Password</div>
    <input name="password" type="password" autocomplete="current-password" required
           style="width:100%;padding:10px 12px;border:1px solid #ECEDEF;border-radius:8px;font-size:15px">
  </label>
  <button class="cta" type="submit" style="border:none;cursor:pointer;width:100%">Sign in</button>
</form>
<p class="muted">Accounts are created by an admin. There is no self-signup.</p>`;
  return shell('Deadman - moderator sign-in', head, body);
}
