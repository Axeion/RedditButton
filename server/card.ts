import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { bandById } from '@shared/bands.ts';
import type { PressDTO } from '@shared/protocol.ts';

const WIDTH = 1200;
const HEIGHT = 630;

const FONT = 'DeadmanSans';

/**
 * Fonts are vendored (see assets/fonts/README.md) because a host without system
 * fonts renders a blank card, which is worse than no card at all. Dev runs from
 * the repo root; the bundled build runs from dist/ — try both, then fall back
 * to system paths.
 */
function registerFonts(): boolean {
  const candidates = [
    path.join(import.meta.dirname, 'assets', 'fonts'),
    path.join(import.meta.dirname, '..', 'assets', 'fonts'),
    '/usr/share/fonts/truetype/liberation',
    '/usr/share/fonts/truetype/dejavu',
  ];

  for (const dir of candidates) {
    const bold = ['LiberationSans-Bold.ttf', 'DejaVuSans-Bold.ttf']
      .map((f) => path.join(dir, f))
      .find((p) => fs.existsSync(p));
    const regular = ['LiberationSans-Regular.ttf', 'DejaVuSans.ttf']
      .map((f) => path.join(dir, f))
      .find((p) => fs.existsSync(p));

    if (bold && regular) {
      GlobalFonts.registerFromPath(regular, FONT);
      GlobalFonts.registerFromPath(bold, `${FONT}Bold`);
      return true;
    }
  }
  console.warn('[card] no font found; share cards will use a system default');
  return false;
}

const fontsReady = registerFonts();
const face = (weight: 'bold' | 'regular', size: number) =>
  fontsReady
    ? `${size}px ${weight === 'bold' ? `${FONT}Bold` : FONT}`
    : `${weight === 'bold' ? 'bold ' : ''}${size}px sans-serif`;

function roundRect(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderCard(press: PressDTO): Promise<Buffer> {
  const band = bandById(press.band);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // White field, red accents.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Band stripe down the left edge — the flair is the point of the card.
  ctx.fillStyle = band.hex;
  ctx.fillRect(0, 0, 18, HEIGHT);

  // Wordmark
  ctx.fillStyle = '#E03131';
  ctx.font = face('bold', 34);
  ctx.fillText('DEADMAN', 70, 86);
  ctx.fillStyle = '#8A8F96';
  ctx.font = face('regular', 22);
  ctx.fillText('It stays alive while someone still presses.', 70, 120);

  // The number, which is the whole story.
  ctx.fillStyle = '#111315';
  ctx.font = face('bold', 190);
  const timeText = `${press.secondsLeft.toFixed(2)}s`;
  ctx.fillText(timeText, 66, 310);

  ctx.fillStyle = '#6B7075';
  ctx.font = face('regular', 30);
  ctx.fillText('left on the clock', 74, 360);

  // Flair pill
  const pillLabel = `${band.label.toUpperCase()}`;
  ctx.font = face('bold', 28);
  const pillW = ctx.measureText(pillLabel).width + 56;
  ctx.fillStyle = band.hex;
  roundRect(ctx, 70, 400, pillW, 60, 30);
  ctx.fill();
  ctx.fillStyle = band.id === 'gold' ? '#3A2A00' : '#FFFFFF';
  ctx.fillText(pillLabel, 98, 440);

  // Name
  ctx.fillStyle = band.textHex;
  ctx.font = face('bold', 44);
  ctx.fillText(press.name, 70, 530);

  ctx.fillStyle = '#8A8F96';
  ctx.font = face('regular', 26);
  const rankText = press.rank ? `Rank #${press.rank} - era ${press.eraId}` : `Era ${press.eraId}`;
  ctx.fillText(rankText, 70, 572);

  // Right-hand blurb, vertically centred against the big number.
  ctx.textAlign = 'right';
  ctx.fillStyle = band.hex;
  ctx.font = face('bold', 40);
  ctx.fillText(band.blurb, WIDTH - 70, 300);
  ctx.textAlign = 'left';

  return canvas.encode('png');
}
