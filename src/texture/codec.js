'use strict';
/**
 * Decode / encode one mip level between GPU format bytes and RGBA8 pixels.
 */
const { FMT } = require('../formats/texfmt');
const bc1 = require('./bc1');
const bc7 = require('./bc7');

const _blk = new Uint8Array(64);

function forEachBlock(width, height, fn) {
  const bw = Math.max(1, Math.ceil(width / 4));
  const bh = Math.max(1, Math.ceil(height / 4));
  let b = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) fn(bx, by, b++);
}

function scatter(blk, rgba, width, height, bx, by) {
  for (let y = 0; y < 4; y++) {
    const py = by * 4 + y; if (py >= height) break;
    for (let x = 0; x < 4; x++) {
      const px = bx * 4 + x; if (px >= width) break;
      const s = (y * 4 + x) * 4, d = (py * width + px) * 4;
      rgba[d] = blk[s]; rgba[d + 1] = blk[s + 1]; rgba[d + 2] = blk[s + 2]; rgba[d + 3] = blk[s + 3];
    }
  }
}

function gather(rgba, width, height, bx, by, blk) {
  for (let y = 0; y < 4; y++) {
    const py = Math.min(height - 1, by * 4 + y);
    for (let x = 0; x < 4; x++) {
      const px = Math.min(width - 1, bx * 4 + x);
      const s = (py * width + px) * 4, d = (y * 4 + x) * 4;
      blk[d] = rgba[s]; blk[d + 1] = rgba[s + 1]; blk[d + 2] = rgba[s + 2]; blk[d + 3] = rgba[s + 3];
    }
  }
}

/**
 * @param {number} fmt
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} RGBA8 width*height*4
 */
function decodeMip(fmt, bytes, width, height) {
  const rgba = new Uint8Array(width * height * 4);
  switch (fmt) {
    case FMT.DXT1:
      forEachBlock(width, height, (bx, by, b) => { bc1.decodeColorBlock(bytes, b * 8, _blk, false); scatter(_blk, rgba, width, height, bx, by); });
      break;
    case FMT.DXT3:
      forEachBlock(width, height, (bx, by, b) => { bc1.decodeColorBlock(bytes, b * 16 + 8, _blk, true); bc1.decodeAlphaBC2(bytes, b * 16, _blk); scatter(_blk, rgba, width, height, bx, by); });
      break;
    case FMT.DXT5:
      forEachBlock(width, height, (bx, by, b) => { bc1.decodeColorBlock(bytes, b * 16 + 8, _blk, true); bc1.decodeAlphaBC3(bytes, b * 16, _blk); scatter(_blk, rgba, width, height, bx, by); });
      break;
    case FMT.BC7:
      forEachBlock(width, height, (bx, by, b) => { bc7.decodeBlock(bytes, b * 16, _blk); scatter(_blk, rgba, width, height, bx, by); });
      break;
    case FMT.A8R8G8B8: case FMT.X8R8G8B8:
      for (let i = 0, n = width * height; i < n; i++) {
        rgba[i * 4] = bytes[i * 4 + 2]; rgba[i * 4 + 1] = bytes[i * 4 + 1]; rgba[i * 4 + 2] = bytes[i * 4];
        rgba[i * 4 + 3] = fmt === FMT.X8R8G8B8 ? 255 : bytes[i * 4 + 3];
      }
      break;
    case FMT.A8B8G8R8:
      rgba.set(bytes.subarray(0, width * height * 4));
      break;
    default:
      throw new Error(`decodeMip: unsupported format ${fmt}`);
  }
  return rgba;
}

/**
 * Encode RGBA8 into `out` (same size as the original mip bytes).
 * `original` is the original mip bytes; used to copy untouched alpha blocks bit-exact.
 */
function encodeMip(fmt, rgba, width, height, out, original) {
  switch (fmt) {
    case FMT.DXT1:
      forEachBlock(width, height, (bx, by, b) => { gather(rgba, width, height, bx, by, _blk); bc1.encodeColorBlock(_blk, out, b * 8, 'bc1'); });
      break;
    case FMT.DXT3: case FMT.DXT5:
      forEachBlock(width, height, (bx, by, b) => {
        gather(rgba, width, height, bx, by, _blk);
        if (original) { if (original !== out) out.set(original.subarray(b * 16, b * 16 + 8), b * 16); } // alpha untouched, bit-exact
        else if (fmt === FMT.DXT5) bc1.encodeAlphaBC3(_blk, out, b * 16);
        else bc1.encodeAlphaBC2(_blk, out, b * 16);
        bc1.encodeColorBlock(_blk, out, b * 16 + 8, 'bc3');
      });
      break;
    case FMT.BC7:
      forEachBlock(width, height, (bx, by, b) => { gather(rgba, width, height, bx, by, _blk); bc7.encodeBlock(_blk, out, b * 16); });
      break;
    case FMT.A8R8G8B8: case FMT.X8R8G8B8:
      for (let i = 0, n = width * height; i < n; i++) {
        out[i * 4] = rgba[i * 4 + 2]; out[i * 4 + 1] = rgba[i * 4 + 1]; out[i * 4 + 2] = rgba[i * 4];
        out[i * 4 + 3] = fmt === FMT.X8R8G8B8 && original ? original[i * 4 + 3] : rgba[i * 4 + 3];
      }
      break;
    case FMT.A8B8G8R8:
      out.set(rgba.subarray(0, width * height * 4));
      break;
    default:
      throw new Error(`encodeMip: unsupported format ${fmt}`);
  }
}

module.exports = { decodeMip, encodeMip };
