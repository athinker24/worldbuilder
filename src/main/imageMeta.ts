// Bytes in, bytes out — no database, no filesystem, nothing to mock. It lived in db.ts beside a
// connection it never touched; here it can be read, and reasoned about, on its own. That matters
// more than usual for this one: it is a security gate (docs/security-gates.md, gate 33) whose
// entire argument is about byte layout.

/**
 * Image metadata that describes the PERSON rather than the picture, removed from what LEAVES.
 *
 * A photo carries more than pixels. EXIF holds GPS coordinates to a few metres, the camera's
 * serial number and the exact second the shutter opened; XMP holds the author's name and an
 * editing history; IPTC holds a creator and a copyright line. `importAsset` copies the file byte
 * for byte and `packWorld` embeds it byte for byte, so any of that travelled inside every
 * `.world` handed to anybody — the same shape as the author's disk path, and the same answer.
 *
 * Stripped on the way OUT, not on the way in. The user's own copy in `assets/` keeps whatever it
 * came with, which is theirs; only the file they hand to someone else is cleaned. That also covers
 * every image imported before this existed, at no extra cost, because packWorld already reads all
 * of them.
 *
 * ICC (APP2) and Adobe (APP14) are KEPT: those describe the colour, and dropping them changes how
 * the picture looks. Anything unexpected — a truncated file, a marker where none belongs — returns
 * the original bytes untouched. A cleaner that can corrupt an image is worse than the metadata.
 */
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]) // APP1 (EXIF, XMP), APP13 (IPTC), COM
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])
const WEBP_DROP = new Set(['EXIF', 'XMP ']) // the two RIFF chunks that describe the photographer
export function stripImageMetadata(buf: Buffer): Buffer {
  try {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return stripJpeg(buf)
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return stripPng(buf)
    // RIFF....WEBP — the four bytes between are the file size, so the check is split.
    if (
      buf.length > 12 &&
      buf.toString('latin1', 0, 4) === 'RIFF' &&
      buf.toString('latin1', 8, 12) === 'WEBP'
    )
      return stripWebp(buf)
    if (buf.length > 6 && buf.toString('latin1', 0, 3) === 'GIF') return stripGif(buf)
  } catch {
    /* not the shape we thought: hand back exactly what came in */
  }
  return buf
}

/** Rebuild only if something was actually removed. Every stripper ends here: the common case is a
 *  picture with no metadata at all, and Buffer.concat on it would allocate a second copy of the
 *  whole image on every save — this app's base maps run to a hundred megabytes. */
const rebuilt = (buf: Buffer, out: Buffer[], dropped: boolean): Buffer =>
  dropped ? Buffer.concat(out) : buf

function stripJpeg(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 2)] // SOI
  let dropped = false
  let i = 2
  while (i + 1 < buf.length) {
    // Encoders may pad between segments with 0xff; those are fill bytes, not markers.
    while (i + 1 < buf.length && buf[i] === 0xff && buf[i + 1] === 0xff) i++
    if (buf[i] !== 0xff) return buf // lost the marker chain — do not rewrite what we cannot read
    const marker = buf[i + 1]
    // Standalone markers: no length, no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(buf.subarray(i, i + 2))
      i += 2
      continue
    }
    // SOS starts the entropy-coded data and EOI ends the image; in both cases the rest of the file
    // is not a segment chain any more. EOI used to fall through to the length read below, so on a
    // file with an EOI before its first SOS the walk desynchronised into image data — and if the
    // bytes it landed on happened to look like an APP1 marker it deleted a span of the PICTURE and
    // still returned it as successfully stripped. Copy the remainder and stop.
    if (marker === 0xda || marker === 0xd9) {
      out.push(buf.subarray(i))
      return rebuilt(buf, out, dropped)
    }
    if (i + 3 >= buf.length) return buf
    const len = buf.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > buf.length) return buf
    if (JPEG_DROP.has(marker)) dropped = true
    else out.push(buf.subarray(i, i + 2 + len))
    i += 2 + len
  }
  // Ran out of bytes without ever reaching SOS or EOI. That is not a JPEG this function followed
  // to the end, so it hands back the original rather than a version it has quietly shortened.
  return buf
}

function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 8)] // signature
  let dropped = false
  let i = 8
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    if (len > 0x7fffffff) return buf
    const end = i + 12 + len // length + type + data + crc
    if (end > buf.length) return buf
    const type = buf.toString('latin1', i + 4, i + 8)
    // Whole chunks are dropped, so no CRC has to be recomputed — every chunk kept is byte-identical.
    if (PNG_DROP.has(type)) dropped = true
    else out.push(buf.subarray(i, end))
    i = end
    if (type === 'IEND') {
      // Some tools append data after IEND. It is not a chunk and we do not know what it is, so it
      // is carried over VERBATIM — not dropped, and not made a reason to give up on the whole
      // file, which would let the metadata ride along in exactly the files that are already
      // unusual. Removing metadata is the job; shortening an image is not.
      if (i < buf.length) out.push(buf.subarray(i))
      return rebuilt(buf, out, dropped)
    }
  }
  return buf
}

/**
 * WebP, which is where this matters most now: a phone photo saved or converted to .webp keeps its
 * EXIF, and `importAsset` has always accepted the extension — so the format most likely to carry
 * GPS was the one format with no stripper.
 *
 * RIFF is a flat chunk list: 'RIFF', a 32-bit size, 'WEBP', then fourcc + size + payload, each
 * payload padded to an even length. Dropping a chunk means the container size in the header no
 * longer matches, so it is rewritten — the ONE place any stripper here edits a byte rather than
 * omitting one, and it is four bytes of arithmetic on a length we just recomputed.
 */
function stripWebp(buf: Buffer): Buffer {
  const body: Buffer[] = [buf.subarray(8, 12)] // 'WEBP'
  let dropped = false
  let i = 12
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32LE(i + 4)
    if (size > 0x7fffffff) return buf
    const end = i + 8 + size + (size % 2) // odd payloads carry a pad byte
    if (end > buf.length) return buf
    if (WEBP_DROP.has(buf.toString('latin1', i, i + 4))) dropped = true
    else body.push(buf.subarray(i, end))
    i = end
  }
  // The walk has to land exactly on the end, or this is not a chunk list we followed.
  if (i !== buf.length || !dropped) return buf
  const rest = Buffer.concat(body)
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(rest.length, 4)
  return Buffer.concat([head, rest])
}

/**
 * GIF. The comment extension is the metadata block — generator strings, and occasionally whatever
 * someone typed. Application extensions are KEPT except XMP: NETSCAPE2.0 is what makes an animated
 * GIF loop, and dropping it would change how the picture plays.
 *
 * Walking a GIF means walking its whole block structure, because a comment can sit between frames:
 * header, logical screen descriptor, an optional global colour table, then blocks until the
 * trailer. Anything unexpected returns the original.
 */
function stripGif(buf: Buffer): Buffer {
  const sub = (at: number): number => {
    // Sub-block chain: one length byte, that many bytes, repeated, ended by a zero length.
    let j = at
    while (j < buf.length) {
      const n = buf[j]
      if (n === 0) return j + 1
      j += 1 + n
    }
    return -1
  }
  if (buf.length < 13) return buf
  const flags = buf[10]
  // Global colour table: 3 bytes per entry, 2^(N+1) entries, present only when the top flag is set.
  let i = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0)
  const out: Buffer[] = []
  let keptFrom = 0
  let dropped = false
  while (i < buf.length) {
    const b = buf[i]
    if (b === 0x3b) {
      // trailer
      out.push(buf.subarray(keptFrom))
      return rebuilt(buf, out, dropped)
    }
    let next: number
    let drop = false
    if (b === 0x21) {
      // extension: label, then either a fixed block or a sub-block chain
      const label = buf[i + 1]
      if (label === 0xfe) drop = true // comment
      if (label === 0xff) {
        // application extension — only XMP is metadata; NETSCAPE2.0 drives looping and stays
        if (buf.toString('latin1', i + 3, i + 11) === 'XMP Data') drop = true
        next = sub(i + 3 + buf[i + 2])
      } else next = label === 0xfe ? sub(i + 2) : sub(i + 3 + buf[i + 2])
    } else if (b === 0x2c) {
      // image descriptor: 10 bytes, an optional local colour table, LZW min code size, sub-blocks
      if (i + 10 > buf.length) return buf
      const lf = buf[i + 9]
      const after = i + 10 + (lf & 0x80 ? 3 * (1 << ((lf & 0x07) + 1)) : 0)
      next = sub(after + 1)
    } else return buf // not a block boundary we understand
    if (next < 0 || next > buf.length) return buf
    if (drop) {
      out.push(buf.subarray(keptFrom, i))
      keptFrom = next
      dropped = true
    }
    i = next
  }
  return buf // ran out before the trailer
}
