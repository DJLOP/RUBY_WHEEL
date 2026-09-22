/**
 * Real PNG and JPEG bytes, built here rather than committed as binary fixtures.
 *
 * The reference-layer route takes a file's format and dimensions from its bytes and
 * ignores what the uploader claimed, so its tests need files that genuinely are what they
 * say — and, for the rejection cases, files that genuinely are not. Generating them keeps
 * the "disguised file" cases honest: a `.png` name over JPEG bytes is a real JPEG here,
 * not a string in a fixture list.
 */

const zlib = require('zlib');

const crc32 = (buf) => {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
};

const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
};

/** A valid RGBA PNG of the given size, filled with one colour. */
function makePng(width, height, fill = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const scanline = Buffer.alloc(width * 4 + 1, fill);
  scanline[0] = 0; // filter: none
  const raw = Buffer.concat(Array.from({ length: height }, () => scanline));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A JPEG whose SOF0 frame header carries the given size.
 *
 * Only the structure a metadata reader walks — start of image, JFIF application segment,
 * a baseline frame header, end of image. There is no entropy-coded scan, because nothing
 * under test decodes pixels; what is under test is that the server reads its dimensions
 * from here instead of from the filename.
 */
function makeJpeg(width, height) {
  const app0 = Buffer.concat([
    Buffer.from([0xFF, 0xE0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  const sof0 = Buffer.alloc(21);
  sof0.writeUInt16BE(0xFFC0, 0);
  sof0.writeUInt16BE(17, 2);      // segment length
  sof0[4] = 8;                    // sample precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;                    // component count
  for (let i = 0; i < 3; i++) {
    sof0[10 + i * 3] = i + 1;     // component id
    sof0[11 + i * 3] = 0x11;      // sampling factors
    sof0[12 + i * 3] = 0;         // quantisation table
  }
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    app0,
    sof0,
    Buffer.from([0xFF, 0xD9]),
  ]);
}

/** A valid GIF header — a real raster, and one this feature does not accept. */
function makeGif(width, height) {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** Bytes that are not an image in any format. */
const makeGarbage = (size = 64) => Buffer.alloc(size, 0x7a);

module.exports = { makePng, makeJpeg, makeGif, makeGarbage };
