'use strict';

const fs = require('fs');

function u32View(buf, offsetBytes, lengthU32) {
  return new Uint32Array(buf.buffer, buf.byteOffset + offsetBytes, lengthU32);
}

function loadIndex(indexBinPath, asnMapJsonPath) {
  const buf = fs.readFileSync(indexBinPath);
  if (buf.slice(0, 4).toString('utf8') !== 'ASNV') {
    throw new Error('Bad ASN index');
  }

  const count = buf.readUInt32LE(8);
  let off = 16;

  const starts = u32View(buf, off, count); off += count * 4;
  const ends   = u32View(buf, off, count); off += count * 4;
  const asns   = u32View(buf, off, count);

  const map = JSON.parse(fs.readFileSync(asnMapJsonPath, 'utf8'));
  const asnList = map.asn;
  const isDc = new Set(
    asnList.filter((_, i) => map.isDc[i] === 1)
  );

  return { starts, ends, asns, isDc };
}

function u32To16(ip) {
  return ip >>> 16; // top 16 bits
}

function format16(n) {
  const a = (n >>> 8) & 255;
  const b = n & 255;
  return `${a}.${b}.0.0/16`;
}

function main() {
  const [idxPath, mapPath] = process.argv.slice(2);
  if (!idxPath || !mapPath) {
    console.error('Usage: node extract-datacenter-16s.js <asn_index.bin> <asn_map.json>');
    process.exit(1);
  }

  const { starts, ends, asns, isDc } = loadIndex(idxPath, mapPath);

  const prefixes = new Set();

  for (let i = 0; i < starts.length; i++) {
    const asn = asns[i];
    if (!isDc.has(asn)) continue;

    const start16 = u32To16(starts[i]);
    const end16   = u32To16(ends[i]);

    for (let p = start16; p <= end16; p++) {
      prefixes.add(p);
    }
  }

  const out = Array.from(prefixes)
    .sort((a, b) => a - b)
    .map(format16);

  fs.writeFileSync('datacenter_16s.txt', out.join('\n'));
  console.log(`Wrote ${out.length} /16 ranges`);
}

main();