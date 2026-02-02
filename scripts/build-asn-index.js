#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseCsvLineSimple(line) {
  // Minimal CSV parser with quotes support
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseIPv4ToU32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  // >>>0 to force uint32
  return (n >>> 0);
}

function cidrToV4RangeU32(cidr) {
  const [addr, prefixStr] = cidr.split('/');
  if (!addr || !prefixStr) return null;

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  const ip = parseIPv4ToU32(addr);
  if (ip === null) return null;

  const hostBits = 32 - prefix;
  const mask = hostBits === 32 ? 0 : ((0xFFFFFFFF << hostBits) >>> 0);

  const start = (ip & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  return { start, end };
}

function classifyOrgDatacenter(org, asn) {
  const o = (org || '').toLowerCase();

  // Keep this conservative; you can extend.
  const knownDatacenterAsns = new Set([
    13335, 14061, 16276, 24940, 63949, 20473, 54113, 20940, 12222, 60781, 8560, 12876, 202053, 27357,
    16509, 14618, 8987, 15169, 19527, 8075, 8068,
  ]);
  if (typeof asn === 'number' && knownDatacenterAsns.has(asn)) return true;

  const datacenterKeywords = [
    'hosting', 'host', 'vps', 'virtual', 'compute', 'datacenter', 'data center',
    'colo', 'colocation', 'server', 'infrastructure', 'iaas', 'bare metal', 'dedicated',
    'digitalocean', 'linode', 'hetzner', 'ovh', 'vultr', 'leaseweb', 'scaleway',
    'ionos', '1&1', 'contabo', 'choopa', 'racknerd', 'hivelocity',
    'cloudflare', 'fastly', 'akamai', 'edge', 'cdn',
    'amazon', 'aws', 'google', 'google cloud', 'gcp', 'microsoft', 'azure', 'oracle cloud', 'oci',
  ];
  if (datacenterKeywords.some((k) => o.includes(k))) return true;

  return false;
}

// Builds an IPv4 /16 prefix table:
// prefix = start>>>16 (0..65535)
// table[prefix] = [loIndex, hiIndex) range in sorted arrays
function buildPrefix16Table(starts) {
  const table = new Uint32Array(65536 * 2);
  // initialize to "empty": lo=hi=0
  // We’ll fill progressively.
  let idx = 0;
  for (let p = 0; p < 65536; p++) {
    const lo = idx;
    while (idx < starts.length && (starts[idx] >>> 16) === p) idx++;
    const hi = idx;
    table[p * 2] = lo;
    table[p * 2 + 1] = hi;
  }
  return table;
}

async function main() {
  const argv = process.argv.slice(2);
  const inPath = argv[0];
  const outDir = argv[1] || './data_precomputed';

  if (!inPath) {
    console.error('Usage: node scripts/build-asn-index.js <GeoLite2-ASN-Blocks-IPv4.csv> [outDir]');
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const ranges = []; // temp objects only during build
  const asnIsDc = new Map(); // ASN -> boolean

  const rl = readline.createInterface({
    input: fs.createReadStream(inPath),
    crlfDelay: Infinity,
  });

  let isHeader = true;
  let kept = 0;
  let seen = 0;

  for await (const line of rl) {
    if (!line) continue;
    if (isHeader) { isHeader = false; continue; }

    const cols = parseCsvLineSimple(line);
    const network = cols[0];
    const asn = cols[1] ? Number(cols[1]) : null;
    const org = cols[2] || '';

    if (!network || !Number.isInteger(asn) || asn <= 0) continue;
    const r = cidrToV4RangeU32(network);
    if (!r) continue;

    ranges.push({ start: r.start, end: r.end, asn });
    seen++;

    // compute ASN datacenter map (once)
    if (!asnIsDc.has(asn)) {
      asnIsDc.set(asn, classifyOrgDatacenter(org, asn));
    } else {
      // If we previously said false, allow a later true org to flip it.
      if (asnIsDc.get(asn) === false) {
        const dc = classifyOrgDatacenter(org, asn);
        if (dc) asnIsDc.set(asn, true);
      }
    }

    kept++;
    if (kept % 500000 === 0) {
      console.log(`Parsed ${kept.toLocaleString()} rows...`);
    }
  }

  console.log(`Rows parsed: ${seen.toLocaleString()}`);
  console.log('Sorting ranges...');
  ranges.sort((a, b) => (a.start - b.start));

  // Build compact typed arrays
  const n = ranges.length;
  const starts = new Uint32Array(n);
  const ends = new Uint32Array(n);
  const asns = new Uint32Array(n);

  for (let i = 0; i < n; i++) {
    const r = ranges[i];
    starts[i] = r.start >>> 0;
    ends[i] = r.end >>> 0;
    asns[i] = r.asn >>> 0;
  }

  console.log('Building /16 prefix table...');
  const prefix16 = buildPrefix16Table(starts);

  // Serialize:
  // Header:
  // 4 bytes magic "ASNV"
  // 4 bytes version (uint32)
  // 4 bytes count (uint32)
  // then:
  // starts (count * 4)
  // ends (count * 4)
  // asns (count * 4)
  // prefix16 table (65536*2 * 4)
  const magic = Buffer.from('ASNV');
  const header = Buffer.alloc(12);
  header.writeUInt32LE(1, 0); // version
  header.writeUInt32LE(n, 4); // count
  header.writeUInt32LE(0, 8); // reserved

  function u32ToBuf(u32arr) {
    return Buffer.from(u32arr.buffer, u32arr.byteOffset, u32arr.byteLength);
  }

  const outBin = Buffer.concat([
    magic,
    header,
    u32ToBuf(starts),
    u32ToBuf(ends),
    u32ToBuf(asns),
    u32ToBuf(prefix16),
  ]);

  const outIndexPath = path.join(outDir, 'asn_index_v4.bin');
  fs.writeFileSync(outIndexPath, outBin);

  // ASN datacenter map: store as two arrays for compactness
  // asn_list.json: { asn: [..], isDc: [0/1..] }
  const asnList = Array.from(asnIsDc.keys()).sort((a, b) => a - b);
  const isDcList = asnList.map((a) => (asnIsDc.get(a) ? 1 : 0));

  const outMapPath = path.join(outDir, 'asn_datacenter_map.json');
  fs.writeFileSync(outMapPath, JSON.stringify({ asn: asnList, isDc: isDcList }, null, 2));

  console.log('Wrote:');
  console.log(' ', outIndexPath);
  console.log(' ', outMapPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
